import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sharedExtensions } from '@/editor/extensions/shared';
import { commentTo, PageMentionCard } from '@/gitquire-people/PageMentionCard';
import { mentionRanges } from '@/gitquire-people/page-mention-find';
import { CommentsPanel, DiscussionPanel } from './DiscussionPanel';
import { anchorFromSelection } from './editor-threads';
import { createThread } from './thread-ops';
import { writeAndTrack } from './thread-sync';
import { clearDraft, openThread, revealDiscussion, setActiveThread, startDraft } from './ui-store';

const DOC = 'notes/plan';
const mounted: { editor: Editor; container: HTMLDivElement }[] = [];
const browserFocus = HTMLElement.prototype.focus;
const ownFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus');

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

function hiddenByVisibility(element: Element | null): boolean {
  for (let node = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.visibility === 'hidden') return true;
  }
  return false;
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'focus', {
    configurable: true,
    writable: true,
    value: function focusLikeABrowser(this: HTMLElement, options?: FocusOptions) {
      if (hiddenByVisibility(this)) return;
      browserFocus.call(this, options);
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'https://wiki.example.com');
      if (url.pathname === '/auth/me') {
        return json({ principalId: 'github-1', login: 'anna', name: 'Anna' });
      }
      if (url.pathname === '/api/gitquire/people') return json({ people: [], me: 'anna' });
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  clearDraft();
  setActiveThread(null);
  if (ownFocus === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'focus');
  else Object.defineProperty(HTMLElement.prototype, 'focus', ownFocus);
  vi.unstubAllGlobals();
  for (const { editor, container } of mounted.splice(0)) {
    editor.destroy();
    container.remove();
  }
});

function mount(content: string): Editor {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({ element: container, content, extensions: sharedExtensions });
  mounted.push({ editor, container });
  return editor;
}

function rangeOf(editor: Editor, text: string): { from: number; to: number } {
  let from = -1;
  editor.state.doc.descendants((node, pos) => {
    if (from !== -1 || !node.isText) return;
    const at = node.text?.indexOf(text) ?? -1;
    if (at !== -1) from = pos + at;
  });
  return { from, to: from + text.length };
}

function startCommentOn(editor: Editor, text: string): void {
  const { from, to } = rangeOf(editor, text);
  const anchor = anchorFromSelection(editor.state.doc, from, to);
  if (anchor === undefined) throw new Error('no anchor');
  act(() => startDraft(DOC, { anchor, from, to }));
}

function addThread(editor: Editor, exact: string): string {
  const created = createThread([], { exact }, 'First remark', {
    author: { id: 'github-2', login: 'ben', name: 'Ben' },
    now: () => new Date(),
    newId: () => 'c1',
  });
  const range = rangeOf(editor, exact);
  const mark = range.from === -1 ? undefined : { id: created.thread.id, pos: range.to };
  act(() => {
    writeAndTrack(editor, created.threads, mark);
  });
  return created.thread.id;
}

describe('starting a comment puts the cursor in the comment field', () => {
  test('a new comment on a selection can be typed right away', async () => {
    const editor = mount('<p>The budget needs a second look.</p>');
    render(<DiscussionPanel editor={editor} docName={DOC} />);
    startCommentOn(editor, 'budget');

    const field = screen.getByLabelText('Comment');
    expect(document.activeElement).toBe(field);
    await userEvent.keyboard('Looks high');
    expect((field as HTMLTextAreaElement).value).toBe('Looks high');
  });

  test('the card is hidden by opacity, not visibility, until it is placed', () => {
    const editor = mount('<p>The budget needs a second look.</p>');
    render(<DiscussionPanel editor={editor} docName={DOC} />);
    startCommentOn(editor, 'budget');
    const card = screen.getByTestId('discussion-card');
    expect(card.style.visibility).not.toBe('hidden');
  });

  test('Comment to @name puts the cursor after the name', async () => {
    const editor = mount('<p>Ask @alice about the budget.</p>');
    render(<DiscussionPanel editor={editor} docName={DOC} />);
    const range = mentionRanges(editor.state.doc)[0];
    if (range === undefined) throw new Error('no mention');
    act(() => {
      commentTo(editor, DOC, range);
    });

    const field = screen.getByLabelText<HTMLTextAreaElement>('Comment');
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe('@alice '.length);
    await userEvent.keyboard('please check');
    expect((field as HTMLTextAreaElement).value).toBe('@alice please check');
  });

  test('the mention card takes focus when it opens from the keyboard', () => {
    const editor = mount('<p>Ask @alice about the budget.</p>');
    const range = mentionRanges(editor.state.doc)[0];
    if (range === undefined) throw new Error('no mention');
    render(
      <PageMentionCard editor={editor} docName={DOC} range={range} focusOnOpen onClose={vi.fn()} />,
    );
    expect(document.activeElement).toBe(screen.getByTestId('page-mention-comment'));
  });
});

describe('opening a thread to answer puts the cursor in the reply field', () => {
  test('opening a thread by its comment mark focuses Reply', async () => {
    const editor = mount('<p>The budget needs a second look.</p>');
    render(<DiscussionPanel editor={editor} docName={DOC} />);
    const id = addThread(editor, 'budget');
    act(() => openThread(DOC, id, true));

    const field = screen.getByLabelText('Reply');
    expect(document.activeElement).toBe(field);
    await userEvent.keyboard('Agreed');
    expect((field as HTMLTextAreaElement).value).toBe('Agreed');
  });

  test('clicking inside commented text opens the thread but leaves the cursor alone', () => {
    const editor = mount('<p>The budget needs a second look.</p>');
    render(<DiscussionPanel editor={editor} docName={DOC} />);
    const id = addThread(editor, 'budget');
    act(() => openThread(DOC, id));

    expect(screen.getByLabelText('Reply')).not.toBe(document.activeElement);
  });

  test('choosing a mention in the @ panel focuses Reply', () => {
    const editor = mount('<p>The budget needs a second look.</p>');
    render(<DiscussionPanel editor={editor} docName={DOC} />);
    const id = addThread(editor, 'budget');
    act(() => revealDiscussion(DOC, id));

    expect(document.activeElement).toBe(screen.getByLabelText('Reply'));
  });

  test('choosing a thread in the side pane focuses Reply beside the text', async () => {
    const editor = mount('<p>The budget needs a second look.</p>');
    render(
      <>
        <DiscussionPanel editor={editor} docName={DOC} />
        <CommentsPanel docName={DOC} />
      </>,
    );
    addThread(editor, 'budget');
    const list = screen.getByRole('list', { name: 'Comment threads' });
    fireEvent.click(within(list).getByRole('button', { name: 'budget' }));

    const card = screen.getByTestId('discussion-card');
    const field = within(card).getByLabelText('Reply');
    expect(document.activeElement).toBe(field);
    await userEvent.keyboard('On it');
    expect((field as HTMLTextAreaElement).value).toBe('On it');
  });

  test('choosing a thread whose text is gone focuses Reply in the side pane', () => {
    const editor = mount('<p>The budget needs a second look.</p>');
    render(
      <>
        <DiscussionPanel editor={editor} docName={DOC} />
        <CommentsPanel docName={DOC} />
      </>,
    );
    addThread(editor, 'a removed sentence');
    const list = screen.getByRole('list', { name: 'Comment threads' });
    fireEvent.click(within(list).getByRole('button', { name: 'a removed sentence' }));

    expect(document.activeElement).toBe(within(list).getByLabelText('Reply'));
  });
});
