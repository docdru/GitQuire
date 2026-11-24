import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PageMentionsView } from '@/components/GitQuirePageMentions';
import { openMentionPanel } from '@/gitquire-people/mention-events';
import { MentionInbox } from './MentionInbox';

const requested: string[] = [];

function pageMention(docName: string, login: string, snippet: string) {
  return {
    id: `page:${docName}:${login}:0`,
    path: `${docName}.md`,
    docName,
    login,
    heading: 'Plan',
    snippet,
    occurrence: 0,
    line: 3,
  };
}

const PAGE_MENTIONS = [
  pageMention('notes/plan', 'alice', 'Ask @alice about the budget.'),
  pageMention('notes/plan', 'bob', 'And @bob for the room.'),
  pageMention('team/week', 'alice', 'Thanks @alice.'),
];

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  requested.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      requested.push(input);
      const url = new URL(input, 'https://wiki.example.com');
      if (url.pathname === '/api/gitquire/mentions') {
        return json({ enabled: true, login: 'alice', unread: 0, mentions: [] });
      }
      if (url.pathname === '/api/gitquire/page-mentions') {
        const login = url.searchParams.get('login');
        return json({
          mentions: PAGE_MENTIONS.filter((m) => login === null || m.login === login),
          truncated: false,
        });
      }
      if (url.pathname === '/api/gitquire/people') return json({ people: [], me: 'alice' });
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the @ panel', () => {
  test('lists where I am mentioned in pages without an unread count or badge', async () => {
    render(<MentionInbox />);
    const toggle = await screen.findByTestId('mention-inbox-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Mentions');
    await userEvent.click(toggle);
    await userEvent.click(await screen.findByTestId('mention-tab-pages'));
    const rows = await screen.findByTestId('page-mention-rows');
    expect(rows.textContent).toContain('Ask @alice about the budget.');
    expect(rows.textContent).toContain('Thanks @alice.');
    expect(rows.textContent).not.toContain('@bob');
    expect(requested).toContain('/api/gitquire/page-mentions?login=alice');
    expect(toggle.textContent).toBe('');
    expect(toggle.getAttribute('aria-label')).toBe('Mentions');
  });

  test('opens on the pages tab for another person when asked from a mention card', async () => {
    render(<MentionInbox />);
    await screen.findByTestId('mention-inbox-toggle');
    await waitFor(() => expect(requested).toContain('/api/gitquire/mentions'));
    act(() => openMentionPanel({ tab: 'pages', login: 'bob' }));
    const rows = await screen.findByTestId('page-mention-rows');
    expect(rows.textContent).toContain('And @bob for the room.');
    expect(rows.textContent).not.toContain('@alice');
    expect(screen.getByText('Show where I am mentioned')).toBeTruthy();
  });
});

describe('the Mentions view', () => {
  test('shows my mentions, anyone, or a chosen person', async () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <PageMentionsView active me="alice" person="@me" onPerson={() => {}} onOpen={onOpen} />,
    );
    let rows = await screen.findByTestId('page-mention-rows');
    expect(rows.querySelectorAll('[data-page-mention-id]')).toHaveLength(2);
    rerender(<PageMentionsView active me="alice" person="" onPerson={() => {}} onOpen={onOpen} />);
    rows = await screen.findByTestId('page-mention-rows');
    expect(rows.querySelectorAll('[data-page-mention-id]')).toHaveLength(3);
    expect(rows.textContent).toContain('@bob');
    rerender(
      <PageMentionsView active me="alice" person="bob" onPerson={() => {}} onOpen={onOpen} />,
    );
    rows = await screen.findByTestId('page-mention-rows');
    expect(rows.querySelectorAll('[data-page-mention-id]')).toHaveLength(1);
    await userEvent.click(rows.querySelector('[data-page-mention-id]') as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ login: 'bob' }));
    rerender(
      <PageMentionsView active me={null} person="@me" onPerson={() => {}} onOpen={onOpen} />,
    );
    rows = await screen.findByTestId('page-mention-rows');
    expect(rows.querySelectorAll('[data-page-mention-id]')).toHaveLength(3);
    expect(requested.filter((url) => url.startsWith('/api/gitquire/page-mentions'))).toEqual([
      '/api/gitquire/page-mentions',
    ]);
  });
});
