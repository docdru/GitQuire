import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { sharedExtensions } from '@inkeep/open-knowledge-core/extensions/shared';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, test } from 'vitest';
import { anchorFromSelection, placeThreads, readThreads, writeThreads } from './editor-threads';
import {
  addReply,
  createThread,
  deleteComment,
  editComment,
  extractMentions,
  type OpContext,
  segmentMentions,
  setResolved,
} from './thread-ops';

function context(login: string, id: number): OpContext {
  let counter = 0;
  return {
    author: { id: `github-${id}`, login, name: login },
    now: () => new Date('2026-11-11T12:00:00Z'),
    newId: () => `${login}-${++counter}`,
  };
}

const alice = context('alice', 1);
const bob = context('bob', 2);
const anchor = { exact: 'quarterly numbers' };

describe('mentions', () => {
  test('finds GitHub-style logins once each', () => {
    expect(extractMentions('Hi @Bob and @carol-x, also @bob. Not me@example.com')).toEqual([
      'bob',
      'carol-x',
    ]);
  });

  test('segments text around mentions', () => {
    expect(segmentMentions('ask @bob now')).toEqual([
      { start: 0, text: 'ask ', mention: false },
      { start: 4, text: '@bob', mention: true },
      { start: 8, text: ' now', mention: false },
    ]);
  });
});

describe('thread operations', () => {
  test('create, reply, resolve and reopen', () => {
    const created = createThread([], anchor, 'Can @bob check?', alice);
    expect(created.thread.comments[0]?.mentions).toEqual(['bob']);
    const replied = addReply(created.threads, created.thread.id, 'Done.', bob);
    expect(replied[0]?.comments.map((c) => c.author.login)).toEqual(['alice', 'bob']);
    const resolved = setResolved(replied, created.thread.id, true, bob);
    expect(resolved[0]).toMatchObject({ resolved: true, resolvedBy: 'bob' });
    const reopened = addReply(resolved, created.thread.id, 'One more thing', alice);
    expect(reopened[0]?.resolved).toBe(false);
    expect(reopened[0]?.resolvedBy).toBeUndefined();
  });

  test('only the author edits or deletes a comment; empty threads disappear', () => {
    const { threads, thread } = createThread([], anchor, 'Draft', alice);
    const commentId = thread.comments[0]?.id as string;
    expect(editComment(threads, thread.id, commentId, 'Hacked', bob)[0]?.comments[0]?.body).toBe(
      'Draft',
    );
    const edited = editComment(threads, thread.id, commentId, 'Final', alice);
    expect(edited[0]?.comments[0]).toMatchObject({ body: 'Final', editedAt: expect.any(String) });
    expect(deleteComment(edited, thread.id, commentId, bob.author)).toHaveLength(1);
    expect(deleteComment(edited, thread.id, commentId, alice.author)).toHaveLength(0);
  });
});

describe('editor storage', () => {
  const schema = getSchema(sharedExtensions);
  const md = new MarkdownManager({ extensions: sharedExtensions });

  function stateFor(markdown: string): EditorState {
    return EditorState.create({ schema, doc: schema.nodeFromJSON(md.parse(markdown)) });
  }

  function withThreads(state: EditorState, threads: Parameters<typeof writeThreads>[1]) {
    const tr = writeThreads(state, threads);
    if (tr === undefined) throw new Error('expected a transaction');
    return state.apply(tr);
  }

  test('writes threads into the trailer node and reads them back', () => {
    const state = stateFor('The quarterly numbers look good.\n');
    const { threads } = createThread(readThreads(state.doc), anchor, 'Source?', alice);
    const next = withThreads(state, threads);
    expect(readThreads(next.doc)).toEqual(threads);
    expect(md.serialize(next.doc.toJSON())).toMatch(
      /^The quarterly numbers look good\.\n\n<!-- gitquire-comments v1\n\{.*\}\n-->\n$/,
    );
  });

  test('removes the trailer when the last thread goes', () => {
    const state = stateFor('The quarterly numbers look good.\n');
    const { threads, thread } = createThread([], anchor, 'Source?', alice);
    const withThread = withThreads(state, threads);
    const commentId = thread.comments[0]?.id as string;
    const remaining = deleteComment(threads, thread.id, commentId, alice.author);
    const cleared = withThreads(withThread, remaining);
    expect(md.serialize(cleared.doc.toJSON())).toBe('The quarterly numbers look good.\n');
  });

  test('anchors a selection and finds it again after edits', () => {
    const state = stateFor('Intro.\n\nThe quarterly numbers look good.\n');
    const text = 'quarterly numbers';
    let from = -1;
    state.doc.descendants((node, pos) => {
      const at = node.isText ? (node.text ?? '').indexOf(text) : -1;
      if (from === -1 && at !== -1) from = pos + at;
    });
    const captured = anchorFromSelection(state.doc, from, from + text.length);
    expect(captured?.exact).toBe(text);
    const edited = state.apply(state.tr.insertText('New first line. ', 1));
    const [placed] = placeThreads(edited.doc, [
      { id: 't', anchor: captured as NonNullable<typeof captured>, resolved: false, comments: [] },
    ]);
    expect(placed?.range).not.toBeNull();
    const range = placed?.range as { from: number; to: number };
    expect(edited.doc.textBetween(range.from, range.to)).toBe(text);
  });
});
