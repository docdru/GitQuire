import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { sharedExtensions } from '@/editor/extensions/shared';
import { clearDraft, getDiscussionUi } from '@/gitquire-comments/ui-store';

const { PageMentionCard, PageMentionLayer } = await import('./PageMentionCard');
const { GitQuirePeopleMentions } = await import('./people-mention');
const { listenMentionPanel, revealPageMention } = await import('./mention-events');
const { findPageMention, mentionAt, mentionRanges } = await import('./page-mention-find');

const mounted: { editor: Editor; container: HTMLDivElement }[] = [];

afterEach(() => {
  cleanup();
  clearDraft();
  for (const { editor, container } of mounted.splice(0)) {
    editor.destroy();
    container.remove();
  }
});

function mount(content: string): Editor {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    content,
    extensions: [...sharedExtensions, GitQuirePeopleMentions],
  });
  mounted.push({ editor, container });
  return editor;
}

function toTask(editor: Editor, text: string, checked = false): void {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text?.includes(text)) at = pos + 1;
  });
  editor.chain().setTextSelection(at).toggleTaskList().run();
  if (checked) {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);
      if (node.type.name === 'listItem') {
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup($from.before(depth), undefined, {
            ...node.attrs,
            checked: true,
          }),
        );
        break;
      }
    }
  }
}

describe('finding mentions in the editor', () => {
  test('tells page text from action items and leaves out code', () => {
    const editor = mount(
      '<p>Ask @alice and <code>@coded</code>.</p><p>open @bob</p><p>done @carol</p><pre><code>@block</code></pre>',
    );
    toTask(editor, 'open @bob');
    toTask(editor, 'done @carol', true);
    const ranges = mentionRanges(editor.state.doc).map((range) => [range.login, range.place]);
    expect(ranges).toEqual([
      ['alice', 'page'],
      ['bob', 'action-item'],
      ['carol', 'done-action-item'],
    ]);
  });

  test('finds the spot by snippet first and by occurrence otherwise', () => {
    const editor = mount(
      '<p>First @alice here.</p><p>Second @alice there, see <strong>the</strong> plan.</p>',
    );
    const second = findPageMention(editor.state.doc, {
      login: 'alice',
      occurrence: 0,
      snippet: 'Second @alice there, see the plan.',
    });
    expect(editor.state.doc.textBetween(second?.from ?? 0, editor.state.doc.content.size)).toMatch(
      /^@alice there/,
    );
    const byNumber = findPageMention(editor.state.doc, {
      login: 'alice',
      occurrence: 1,
      snippet: 'text that changed since',
    });
    expect(byNumber?.from).toBe(second?.from);
    expect(
      findPageMention(editor.state.doc, { login: 'nobody', occurrence: 0, snippet: '' }),
    ).toBeUndefined();
  });
});

function cardFor(editor: Editor, login: string) {
  const range = mentionRanges(editor.state.doc).find((candidate) => candidate.login === login);
  if (range === undefined) throw new Error(`no mention of ${login}`);
  const onClose = vi.fn();
  render(
    <PageMentionCard
      editor={editor}
      docName="notes/plan"
      range={range}
      focusOnOpen={false}
      onClose={onClose}
    />,
  );
  return { range, onClose };
}

describe('the card on a page mention', () => {
  test('Comment to @name opens a new comment that already mentions the person', () => {
    const editor = mount('<p>Ask @alice about the budget.</p>');
    const before = editor.getHTML();
    const { onClose } = cardFor(editor, 'alice');
    fireEvent.click(screen.getByTestId('page-mention-comment'));
    const draft = getDiscussionUi().draft;
    expect(getDiscussionUi().docName).toBe('notes/plan');
    expect(draft?.body).toBe('@alice ');
    expect(draft?.anchor.exact).toBe('@alice');
    expect(editor.getHTML()).toBe(before);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  test('Make it an action item turns the line into an open action item and says so', () => {
    const editor = mount('<p>Ask @alice about the budget.</p>');
    cardFor(editor, 'alice');
    const button = screen.getByTestId('page-mention-action-item');
    expect(button.textContent).toContain('Changes the page');
    fireEvent.click(button);
    const alice = mentionAt(editor.state.doc, mentionRanges(editor.state.doc)[0]?.from ?? 0);
    expect(alice?.place).toBe('action-item');
  });

  test('in a list, only that line becomes an action item', () => {
    const editor = mount('<ul><li><p>first line</p></li><li><p>ask @alice</p></li></ul>');
    cardFor(editor, 'alice');
    fireEvent.click(screen.getByTestId('page-mention-action-item'));
    const items: (boolean | null)[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'listItem') items.push(node.attrs.checked as boolean | null);
    });
    expect(items).toEqual([null, false]);
    expect(mentionRanges(editor.state.doc)[0]?.place).toBe('action-item');
  });

  test('is not offered in a heading or a table cell', () => {
    const editor = mount(
      '<h2>For @alice</h2><table><tbody><tr><td><p>cell @bob</p></td></tr></tbody></table>',
    );
    cardFor(editor, 'alice');
    expect(screen.queryByTestId('page-mention-action-item')).toBeNull();
    cleanup();
    cardFor(editor, 'bob');
    expect(screen.queryByTestId('page-mention-action-item')).toBeNull();
  });

  test('All mentions of @name opens the list for that person', () => {
    const editor = mount('<p>Ask @alice about the budget.</p>');
    const requests: unknown[] = [];
    const stop = listenMentionPanel((request) => requests.push(request));
    try {
      cardFor(editor, 'alice');
      fireEvent.click(screen.getByTestId('page-mention-all'));
      expect(requests).toEqual([{ tab: 'pages', login: 'alice' }]);
    } finally {
      stop();
    }
  });

  test('an action item mention says it notifies and offers no second action item', () => {
    const editor = mount('<p>open @bob</p>');
    toTask(editor, 'open @bob');
    cardFor(editor, 'bob');
    expect(screen.getByTestId('page-mention-card').textContent).toContain(
      'This action item notifies @bob.',
    );
    expect(screen.queryByTestId('page-mention-action-item')).toBeNull();
  });

  test('a page mention says it does not notify', () => {
    const editor = mount('<p>Ask @alice.</p>');
    cardFor(editor, 'alice');
    expect(screen.getByTestId('page-mention-card').textContent).toContain('does not notify');
  });
});

describe('opening a page mention from the list', () => {
  test('scrolls to the spot and highlights it briefly', async () => {
    const editor = mount('<p>First @alice here.</p><p>Second @alice there.</p>');
    render(<PageMentionLayer editor={editor} docName="notes/plan" />);
    revealPageMention({
      docName: 'notes/other',
      login: 'alice',
      occurrence: 1,
      snippet: 'Second @alice there.',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(editor.view.dom.querySelector('.gq-mention-flash')).toBeNull();
    revealPageMention({
      docName: 'notes/plan',
      login: 'alice',
      occurrence: 1,
      snippet: 'Second @alice there.',
    });
    await vi.waitFor(() => {
      expect(editor.view.dom.querySelector('.gq-mention-flash')?.textContent).toBe('@alice');
    });
    const second = mentionRanges(editor.state.doc)[1];
    expect(editor.state.selection.from).toBe(second?.from);
  });
});
