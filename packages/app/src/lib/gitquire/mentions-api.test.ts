import { describe, expect, test } from 'vitest';
import {
  fetchMentions,
  type InboxMention,
  type MentionInboxData,
  markMentionsRead,
  pageTitle,
  unreadBadge,
  withMentionsRead,
} from './mentions-api';

function mention(id: string, read: boolean): InboxMention {
  return {
    id,
    path: 'notes/report.md',
    docName: 'notes/report',
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

  test('shows the last part of a page name as its title', () => {
    expect(pageTitle('notes/2026/report')).toBe('report');
    expect(pageTitle('plan')).toBe('plan');
  });

  test('clears the count on mark all, also beyond the listed mentions', () => {
    const many = { ...inbox(), unread: 250 };
    expect(withMentionsRead(many, { all: true }).unread).toBe(0);
  });

  test('caps the badge', () => {
    expect(unreadBadge(3)).toBe('3');
    expect(unreadBadge(250)).toBe('99+');
  });
});
