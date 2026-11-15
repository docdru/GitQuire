import { describe, expect, test } from 'vitest';
import { seedInitialDocHash } from './single-file-initial-doc';

describe('seedInitialDocHash', () => {
  function harness(initialDoc: string | null | undefined, startHash: string) {
    let hash = startHash;
    const sets: string[] = [];
    seedInitialDocHash({
      initialDoc,
      getHash: () => hash,
      setHash: (h) => {
        hash = h;
        sets.push(h);
      },
    });
    return { hash, sets };
  }

  test('seeds #/<doc> when the hash is empty', () => {
    const { hash, sets } = harness('todo', '');
    expect(hash).toBe('#/todo');
    expect(sets).toEqual(['#/todo']);
  });

  test('seeds over the bare `#` and content-root `#/` base states', () => {
    expect(harness('todo', '#').hash).toBe('#/todo');
    expect(harness('todo', '#/').hash).toBe('#/todo');
  });

  test('percent-encodes a docName with a space', () => {
    expect(harness('My Notes', '').hash).toBe('#/My%20Notes');
  });

  test('percent-encodes a docName containing a route metacharacter', () => {
    expect(harness('# 2 - Tokens', '').hash).toBe('#/%23%202%20-%20Tokens');
  });

  test('no-op when initialDoc is null (every non-ephemeral window)', () => {
    expect(harness(null, '').sets).toEqual([]);
  });

  test('no-op when initialDoc is undefined (absent bridge field)', () => {
    expect(harness(undefined, '').sets).toEqual([]);
  });

  test('does not clobber a hash that already carries a doc target', () => {
    const { hash, sets } = harness('todo', '#/other-doc');
    expect(hash).toBe('#/other-doc');
    expect(sets).toEqual([]);
  });

  test('does not clobber an asset or dialog hash', () => {
    expect(harness('todo', '#/__asset__/img.png').sets).toEqual([]);
    expect(harness('todo', '#settings').sets).toEqual([]);
  });
});
