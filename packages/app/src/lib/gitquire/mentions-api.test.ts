import { describe, expect, test } from 'vitest';
import {
  docNameFromPath,
  fetchMentions,
  type InboxMention,
  type MentionInboxData,
  markMentionsRead,
  pageTitleFromPath,
  unreadBadge,
  withMentionsRead,
} from './mentions-api';

function mention(id: string, read: boolean): InboxMention {
  return {
    id,
    path: 'notes/report.md',
    threadId: 't1',
    commentId: id,
    author: { id: 'github-2', login: 'bob' },
    at: '2026-11-11T08:00:00Z',
    body: 'Hi @alice',
    quote: 'quarterly numbers',
    resolved: false,
    read,
  };
}

function inbox(): MentionInboxData {
  return {
    enabled: true,
    login: 'alice',
    unread: 2,
    mentions: [mention('a', false), mention('b', false), mention('c', true)],
  };
}

function fakeFetch(body: unknown, seen: { url: string; init: RequestInit | undefined }[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('mention inbox client', () => {
  test('fetches the inbox and posts what was read', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const data = await fetchMentions({ fetch: fakeFetch(inbox(), seen) });
    expect(data.unread).toBe(2);
    const answering = { fetch: fakeFetch({ unread: 1 }, seen) };
    const result = await markMentionsRead({ ids: ['a'] }, answering);
    expect(result).toEqual({ unread: 1 });
    expect(seen.map((call) => [call.url, call.init?.method, call.init?.body])).toEqual([
      ['/api/gitquire/mentions', 'GET', undefined],
      ['/api/gitquire/mentions/read', 'POST', '{"ids":["a"]}'],
    ]);
  });

  test('marks chosen mentions read locally and keeps the count in step', () => {
    const one = withMentionsRead(inbox(), { ids: ['a', 'c', 'missing'] });
    expect(one.unread).toBe(1);
    expect(one.mentions.map((item) => item.read)).toEqual([true, false, true]);
    const all = withMentionsRead(inbox(), { all: true });
    expect(all.unread).toBe(0);
    expect(all.mentions.every((item) => item.read)).toBe(true);
  });

  test('turns a file path into a page name and title', () => {
    expect(docNameFromPath('notes/report.md')).toBe('notes/report');
    expect(docNameFromPath('README.MD')).toBe('README');
    expect(pageTitleFromPath('notes/2026/report.md')).toBe('report');
    expect(pageTitleFromPath('plan.md')).toBe('plan');
  });

  test('caps the badge', () => {
    expect(unreadBadge(3)).toBe('3');
    expect(unreadBadge(250)).toBe('99+');
  });
});
