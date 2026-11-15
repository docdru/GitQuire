import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { newCommentLabel, splitCommentFootnotes } from './comment-format.ts';
import { normalizeComments } from './comment-threads.ts';

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
