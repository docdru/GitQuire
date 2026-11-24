import { describe, expect, it } from 'vitest';
import { listPageMentions, pageMentionsIn } from './page-mentions.ts';

const PAGE = [
  '---',
  'title: Plan',
  'owner: "@frontmatter"',
  '---',
  '# Plan',
  '',
  'Ask @Alice about the budget, and @bob too.',
  '',
  '## Next steps',
  '',
  '- [ ] @alice sends the numbers',
  '- [x] @bob booked the room',
  '- a list item for @alice to read',
  '',
  'Write to alice@example.com or use `@inline` code.',
  '',
  '```',
  '@fenced',
  '```',
  '',
  '    @indented code',
  '',
  'See [the doc](https://example.com/@linked) by @carol.',
  '<!-- @hidden -->',
  '',
  'Note for @alice[^c-7f3a].',
  '',
  '[^c-7f3a]: 💬 on "Note for"',
  '',
  '    - **@dave** · 2026-11-14 10:32 — @alice please look',
].join('\n');

describe('pageMentionsIn', () => {
  const { mentions, clipped } = pageMentionsIn('notes/plan.md', PAGE);

  it('finds mentions in running text with the heading above and a snippet', () => {
    expect(clipped).toBe(false);
    expect(mentions.map((m) => [m.login, m.occurrence, m.heading])).toEqual([
      ['alice', 0, 'Plan'],
      ['bob', 0, 'Plan'],
      ['alice', 1, 'Next steps'],
      ['carol', 0, 'Next steps'],
      ['alice', 2, 'Next steps'],
    ]);
    const first = mentions[0];
    expect(first).toMatchObject({
      id: 'page:notes/plan:alice:0',
      path: 'notes/plan.md',
      docName: 'notes/plan',
      snippet: 'Ask @Alice about the budget, and @bob too.',
      line: 7,
    });
    expect(mentions[2]?.snippet).toBe('a list item for @alice to read');
    expect(mentions[3]?.snippet).toBe('See the doc by @carol.');
    expect(mentions[4]?.snippet).toBe('Note for @alice.');
  });

  it('leaves out action items, code, links, e-mail addresses, frontmatter and comments', () => {
    const logins = new Set(mentions.map((m) => m.login));
    for (const left of [
      'frontmatter',
      'inline',
      'fenced',
      'indented',
      'linked',
      'hidden',
      'dave',
    ]) {
      expect(logins.has(left), left).toBe(false);
    }
    expect(mentions.some((m) => m.snippet.includes('sends the numbers'))).toBe(false);
    expect(mentions.some((m) => m.snippet.includes('please look'))).toBe(false);
  });

  it('counts several mentions of one person on a page in order', () => {
    const alice = mentions.filter((m) => m.login === 'alice');
    expect(alice.map((m) => m.occurrence)).toEqual([0, 1, 2]);
    expect(new Set(alice.map((m) => m.id)).size).toBe(3);
  });

  it('clips long lines into a short snippet', () => {
    const long = `${'word '.repeat(40)}@erin ${'more '.repeat(40)}`;
    const [found] = pageMentionsIn('a.md', long).mentions;
    expect(found?.snippet.startsWith('…')).toBe(true);
    expect(found?.snippet.endsWith('…')).toBe(true);
    expect(found?.snippet).toContain('@erin');
    expect(found?.snippet.length).toBeLessThan(160);
  });

  it('stops at a limit per page and says so', () => {
    const many = Array.from({ length: 250 }, (_, i) => `@p${i}`).join(' ');
    const result = pageMentionsIn('a.md', many);
    expect(result.mentions).toHaveLength(200);
    expect(result.clipped).toBe(true);
  });
});

describe('listPageMentions', () => {
  const page = (path: string, text: string) => ({
    path,
    modifiedMs: 0,
    value: pageMentionsIn(path, text),
  });

  it('lists pages in path order and filters by person', () => {
    const pages = [page('b.md', '@alice and @bob'), page('a.md', '@Bob')];
    expect(listPageMentions(pages).mentions.map((m) => `${m.path}:${m.login}`)).toEqual([
      'a.md:bob',
      'b.md:alice',
      'b.md:bob',
    ]);
    expect(listPageMentions(pages, 'BOB').mentions.map((m) => m.path)).toEqual(['a.md', 'b.md']);
    expect(listPageMentions(pages, 'nobody')).toEqual({ mentions: [], truncated: false });
  });
});
