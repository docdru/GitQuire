import { describe, expect, test } from 'vitest';
import {
  collapseUnchanged,
  diffBlocks,
  docNameOfPath,
  pathMatchesDoc,
  wordDiff,
} from './draft-diff';

describe('wordDiff', () => {
  test('marks added and removed words', () => {
    expect(wordDiff('the quick fox', 'the slow fox')).toEqual([
      { kind: 'same', text: 'the ' },
      { kind: 'removed', text: 'quick' },
      { kind: 'added', text: 'slow' },
      { kind: 'same', text: ' fox' },
    ]);
  });
});

describe('diffBlocks', () => {
  test('splits into paragraphs and flags the changed ones', () => {
    const blocks = diffBlocks('# Title\n\nOne.\n\nTwo.\n', '# Title\n\nOne.\n\nTwo, more.\n');
    expect(blocks.map((block) => block.changed)).toEqual([false, false, true]);
    expect(blocks[2]?.segments.map((segment) => segment.kind)).toContain('added');
    expect(new Set(blocks.map((block) => block.key)).size).toBe(blocks.length);
  });

  test('collapses unchanged paragraphs far from a change', () => {
    const before = ['A.', 'B.', 'C.', 'D.', 'E.'].join('\n\n');
    const after = ['A.', 'B.', 'C.', 'D.', 'E!'].join('\n\n');
    const view = collapseUnchanged(diffBlocks(before, after));
    expect(view[0]).toMatchObject({ gap: 3 });
    expect(view).toHaveLength(3);
  });
});

describe('page names', () => {
  test('maps file paths to doc names', () => {
    expect(docNameOfPath('notes/plan.md')).toBe('notes/plan');
    expect(docNameOfPath('data.csv')).toBe('data.csv');
    expect(pathMatchesDoc('notes/plan.md', 'notes/plan')).toBe(true);
    expect(pathMatchesDoc('notes/plan.md', null)).toBe(false);
  });
});
