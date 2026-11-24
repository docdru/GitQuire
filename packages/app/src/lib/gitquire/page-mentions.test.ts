import { describe, expect, test } from 'vitest';
import {
  ANYONE,
  fetchPageMentions,
  groupByPage,
  mentionedPeople,
  mentionsOfPerson,
  onlyKnown,
  type PageMention,
  snippetKey,
} from './page-mentions';

function mention(docName: string, login: string, occurrence = 0): PageMention {
  return {
    id: `page:${docName}:${login}:${occurrence}`,
    path: `${docName}.md`,
    docName,
    login,
    heading: 'Plan',
    snippet: `Ask @${login} about it`,
    occurrence,
    line: 3,
  };
}

describe('page mentions', () => {
  const all = [mention('a', 'alice'), mention('a', 'bob'), mention('b', 'alice', 0)];

  test('groups by page in the order given', () => {
    expect(groupByPage(all).map((group) => [group.docName, group.mentions.length])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });

  test('filters by person, and anyone keeps everything', () => {
    expect(mentionsOfPerson(all, 'Alice').map((m) => m.docName)).toEqual(['a', 'b']);
    expect(mentionsOfPerson(all, ANYONE)).toHaveLength(3);
  });

  test('keeps only people the wiki knows, once the list is known', () => {
    expect(onlyKnown(all, new Set(['bob']))).toEqual([all[1]]);
    expect(onlyKnown(all, new Set())).toHaveLength(3);
    expect(onlyKnown(all, undefined)).toHaveLength(3);
  });

  test('counts the people mentioned', () => {
    expect(mentionedPeople(all)).toEqual([
      { login: 'alice', count: 2 },
      { login: 'bob', count: 1 },
    ]);
  });

  test('compares snippets without markup, spaces or the clipping marks', () => {
    expect(snippetKey('…see **the** doc, @Alice!…')).toBe(snippetKey('see the doc @alice'));
  });

  test('asks the server for one person or for everyone', async () => {
    const asked: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ mentions: [], truncated: false }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await fetchPageMentions('a b', { fetch: fetcher as typeof fetch });
    await fetchPageMentions(undefined, { fetch: fetcher as typeof fetch });
    expect(asked).toEqual([
      '/api/gitquire/page-mentions?login=a%20b',
      '/api/gitquire/page-mentions',
    ]);
  });
});
