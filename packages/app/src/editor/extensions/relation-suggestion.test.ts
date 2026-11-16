import { describe, expect, test } from 'vitest';
import { rankRelations, relationInsertion, relationMatcher } from './relation-suggestion.ts';

function stubPosition(textBefore: string, blockStart: number) {
  return {
    $position: {
      parent: { textBetween: () => textBefore },
      parentOffset: textBefore.length,
      start: () => blockStart,
      pos: blockStart + textBefore.length,
    },
  };
}

describe('relationMatcher', () => {
  test('matches a name typed at the start of a paragraph', () => {
    expect(relationMatcher(stubPosition('bl::', 1) as never)).toEqual({
      range: { from: 1, to: 5 },
      query: 'bl',
      text: 'bl::',
    });
  });

  test('matches a bare :: at the start of a paragraph', () => {
    expect(relationMatcher(stubPosition('::', 1) as never)?.query).toBe('');
  });

  test('matches a name inside brackets or parentheses', () => {
    expect(relationMatcher(stubPosition('see [supersedes::', 1) as never)).toEqual({
      range: { from: 6, to: 18 },
      query: 'supersedes',
      text: 'supersedes::',
    });
    expect(relationMatcher(stubPosition('see (part of::', 1) as never)?.query).toBe('part of');
  });

  test('ignores :: after a closed bracket or a code span', () => {
    expect(relationMatcher(stubPosition('call f(x) then std::', 1) as never)).toBeNull();
    expect(relationMatcher(stubPosition('use `std`::', 1) as never)).toBeNull();
  });

  test('ignores a third colon and text after ::', () => {
    expect(relationMatcher(stubPosition('blocks:::', 1) as never)).toBeNull();
    expect(relationMatcher(stubPosition('blocks:: x', 1) as never)).toBeNull();
  });

  test('ignores names that start with a space or are too long', () => {
    expect(relationMatcher(stubPosition(' blocks::', 1) as never)).toBeNull();
    expect(relationMatcher(stubPosition(`${'a'.repeat(61)}::`, 1) as never)).toBeNull();
  });
});

describe('rankRelations', () => {
  const relations = [
    { name: 'blocks', count: 2 },
    { name: 'blocked by', count: 5 },
    { name: 'unblocks', count: 9 },
    { name: 'supersedes', count: 1 },
  ];

  test('an empty query lists the most used first', () => {
    expect(rankRelations(relations, '').map((r) => r.name)).toEqual([
      'unblocks',
      'blocked by',
      'blocks',
      'supersedes',
    ]);
  });

  test('prefix matches come before other matches, case folded', () => {
    expect(rankRelations(relations, 'BLOCK').map((r) => r.name)).toEqual([
      'blocked by',
      'blocks',
      'unblocks',
    ]);
  });

  test('keeps at most eight', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `r${i}`, count: i }));
    expect(rankRelations(many, '')).toHaveLength(8);
  });
});

test('relationInsertion opens a wiki link after the name', () => {
  expect(relationInsertion('blocks')).toBe('blocks:: [[');
});
