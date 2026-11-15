import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { commentLogin, newCommentLabel, splitCommentFootnotes } from './comment-format.ts';
import {
  convertCommentsToFootnotes,
  normalizeComments,
  readCommentThreads,
} from './comment-threads.ts';

const fixtures = new URL('./comment-format-fixtures/', import.meta.url);

const names = readdirSync(fixtures)
  .filter((file) => file.endsWith('.input.md'))
  .map((file) => file.slice(0, -'.input.md'.length));

describe('comment format fixtures', () => {
  test('every input has an expected output', () => {
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  test.each(names)('%s normalizes to its expected output and stays there', (name) => {
    const input = readFileSync(new URL(`${name}.input.md`, fixtures), 'utf8');
    const expected = readFileSync(new URL(`${name}.output.md`, fixtures), 'utf8');
    expect(normalizeComments(input)).toBe(expected);
    expect(normalizeComments(expected)).toBe(expected);
  });
});

describe('labels and splitting', () => {
  test('a new label avoids taken ones and grows when needed', () => {
    let calls = 0;
    const random = () => (calls++ < 64 ? 0 : 0.5);
    expect(newCommentLabel(new Set(['c-0000']), random)).toBe('c-88888');
  });

  test('leaves a page without comment footnotes untouched, line endings included', () => {
    const source = '# T\r\n- [ ] A\r\n';
    expect(splitCommentFootnotes(source)).toEqual({ body: source, blocks: [] });
  });

  test('stays fast on a hostile line', () => {
    const line = `a${' '.repeat(200_000)}[^c-1]`;
    const started = Date.now();
    splitCommentFootnotes(`${line}\n\n[^c-1]: x\n`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('review cases', () => {
  const thread = '[^c-7f3a]: 💬 on "n"\n\n    - **@alice** · 2026-11-14 10:32 — q';

  test('a second definition with the same label adds its comments', () => {
    const md = `n[^c-ab]\n\n[^c-ab]: 💬 on "x"\n    - @alice: first\n\n[^c-ab]: 💬 on "x"\n    - @alice: second\n`;
    expect(readCommentThreads(md)[0]?.comments.map((c) => c.body)).toEqual(['first', 'second']);
  });

  test('a list after the last thread stays page text', () => {
    const md = `n[^c-7f3a]\n\n${thread}\n\n- @bob please check\n- buy milk\n`;
    const split = splitCommentFootnotes(md);
    expect(split.body).toBe('n[^c-7f3a]\n\n- @bob please check\n- buy milk\n');
    expect(normalizeComments(md)).toBe(
      `n[^c-7f3a]\n\n- @bob please check\n- buy milk\n\n${thread}\n`,
    );
  });

  test('a real footnote with a c- label stays a footnote', () => {
    const md = 'Claim[^c-1].\n\n[^c-1]: Smith 2020, p. 4.\n';
    expect(splitCommentFootnotes(md)).toEqual({ body: md, blocks: [] });
    expect(normalizeComments(md)).toBe(md);
  });

  test('a fence line with an info string does not close a fence', () => {
    const md = `\`\`\`\n\`\`\`js\n${thread}\n\`\`\`\n`;
    expect(splitCommentFootnotes(md).blocks).toEqual([]);
  });

  test('a header with a very long run of spaces is read quickly', () => {
    const started = Date.now();
    readCommentThreads(`n[^c-ab]\n\n[^c-ab]: 💬${' '.repeat(200_000)}x\n    - @a: b\n`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('reads threads from a file with Windows line endings', () => {
    const md = `n[^c-7f3a]\r\n\r\n${thread.replace(/\n/g, '\r\n')}\r\n`;
    expect(readCommentThreads(md)[0]?.comments[0]?.body).toBe('q');
  });

  test('turns any author id into a login the format can hold', () => {
    expect(commentLogin({ id: 'principal-0f8e2c4a-1b2c-4d5e-8f90-123456789abc' })).toBe(
      'principal-0f8e2c4a-1b2c-4d5e-8f90-12345',
    );
    expect(commentLogin({ id: 'a.b_c:d' })).toBe('a-b-c-d');
  });
});

describe('v1 conversion never marks inside syntax', () => {
  const block = (exact: string) =>
    `<!-- gitquire-comments v1\n${JSON.stringify({
      id: 't1',
      anchor: { exact },
      resolved: false,
      comments: [
        {
          id: 'c1',
          author: { id: 'g', login: 'alice' },
          createdAt: '2026-11-14T10:00:00Z',
          body: 'x',
        },
      ],
    })}\n-->`;

  test.each([
    '[site](https://example.com/numbers)',
    '[[numbers]]',
    'see <https://numbers.com>',
    'a <span title="numbers">x</span>',
    'math $numbers$ here',
    'code ``numbers`` here',
    'plural numbersx',
  ])('%s', (line) => {
    const out = convertCommentsToFootnotes(`${line}\n\n${block('numbers')}\n`);
    expect(out.split('\n')[0]).toBe(line);
  });
});
