import type { Editor } from '@tiptap/react';
import { describe, expect, test } from 'vitest';
import { getCommentEditor, registerCommentEditor } from './comment-editors';

const first = { id: 'first' } as unknown as Editor;
const second = { id: 'second' } as unknown as Editor;

describe('the side pane finds the open page’s editor', () => {
  test('a registered editor is found by page', () => {
    const unregister = registerCommentEditor('page', first);
    expect(getCommentEditor('page')).toBe(first);
    expect(getCommentEditor('other')).toBeNull();
    unregister();
    expect(getCommentEditor('page')).toBeNull();
  });

  test('an older editor unregistering keeps the newer one', () => {
    const unregisterFirst = registerCommentEditor('page', first);
    const unregisterSecond = registerCommentEditor('page', second);
    unregisterFirst();
    expect(getCommentEditor('page')).toBe(second);
    unregisterSecond();
  });
});
