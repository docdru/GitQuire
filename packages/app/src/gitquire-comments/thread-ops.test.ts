import { MarkdownManager } from '@gitquire/core';
import { GITQUIRE_COMMENTS_NODE } from '@gitquire/core/extensions/gitquire-comments';
import { sharedExtensions } from '@gitquire/core/extensions/shared';
import { serializeCommentTrailer } from '@gitquire/core/gitquire/comment-threads';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, test } from 'vitest';
import { findQuoteRange } from './anchor-search';
import {
  anchorFromSelection,
  canPlaceMark,
  countTrailers,
  findMarks,
  placeThreads,
  readThreads,
  writeThreads,
} from './editor-threads';
import {
  addReply,
  createThread,
  deleteComment,
  editComment,
  editOutcome,
  extractMentions,
  hasCommentBody,
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
  test('create, reply and resolve; resolving removes the thread', () => {
    const created = createThread([], anchor, 'Can @bob check?', alice);
    expect(created.thread.id).toMatch(/^c-[0-9a-f]{4}$/);
    expect(created.thread.comments[0]).toMatchObject({
      author: { id: 'alice', login: 'alice' },
      createdAt: '2026-11-11T12:00:00.000Z',
      mentions: ['bob'],
    });
    const replied = addReply(created.threads, created.thread.id, 'Done.', bob);
    expect(replied[0]?.comments.map((c) => c.author.login)).toEqual(['alice', 'bob']);
    expect(setResolved(replied, created.thread.id, true)).toEqual([]);
    expect(setResolved(replied, created.thread.id, false)).toEqual(replied);
  });

  test('an author without a GitHub login gets a login the format can hold', () => {
    const guest: OpContext = {
      author: { id: 'principal-0f8e2c4a-1b2c-4d5e-8f90-123456789abc' },
      now: () => new Date('2026-11-11T12:00:00Z'),
      newId: () => 'x',
    };
    const created = createThread([], anchor, 'hello there', guest);
    const raw = serializeCommentTrailer(created.threads) as string;
    expect(raw).toContain(
      '- **@principal-0f8e2c4a-1b2c-4d5e-8f90-12345** · 2026-11-11 12:00 — hello there',
    );
  });

  test('two comments by one person in the same minute get distinct ids', () => {
    const created = createThread([], anchor, 'One', alice);
    const twice = addReply(created.threads, created.thread.id, 'Two', alice);
    const ids = twice[0]?.comments.map((c) => c.id) ?? [];
    expect(new Set(ids).size).toBe(2);
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

describe('editing a comment', () => {
  test('decides between saving, leaving unchanged and refusing an empty body', () => {
    expect(editOutcome('  Draft  ', 'Draft')).toEqual({ kind: 'unchanged' });
    expect(editOutcome('   ', 'Draft')).toEqual({ kind: 'empty' });
    expect(editOutcome(' Final ', 'Draft')).toEqual({ kind: 'save', body: 'Final' });
  });

  test('reports whether an edit landed', () => {
    const { threads, thread } = createThread([], anchor, 'Draft', alice);
    const commentId = thread.comments[0]?.id as string;
    const refused = editComment(threads, thread.id, commentId, 'Hacked', bob);
    expect(hasCommentBody(refused, thread.id, commentId, 'Hacked')).toBe(false);
    const edited = editComment(threads, thread.id, commentId, 'Final', alice);
    expect(hasCommentBody(edited, thread.id, commentId, 'Final')).toBe(true);
    const gone = deleteComment(threads, thread.id, commentId, alice.author);
    const afterDelete = editComment(gone, thread.id, commentId, 'Final', alice);
    expect(hasCommentBody(afterDelete, thread.id, commentId, 'Final')).toBe(false);
  });
});

describe('editor storage', () => {
  const schema = getSchema(sharedExtensions);
  const md = new MarkdownManager({ extensions: sharedExtensions });

  function stateFor(markdown: string): EditorState {
    return EditorState.create({ schema, doc: schema.nodeFromJSON(md.parse(markdown)) });
  }

  function withThreads(
    state: EditorState,
    threads: Parameters<typeof writeThreads>[1],
    mark?: Parameters<typeof writeThreads>[2],
  ) {
    const tr = writeThreads(state, threads, mark);
    if (tr === undefined) throw new Error('expected a transaction');
    return state.apply(tr);
  }

  test('writes threads into the trailer node and reads them back', () => {
    const state = stateFor('The quarterly numbers look good.\n');
    const { threads } = createThread(readThreads(state.doc), anchor, 'Source?', alice);
    const next = withThreads(state, threads);
    expect(readThreads(next.doc)).toEqual(threads);
    expect(md.serialize(next.doc.toJSON())).toMatch(
      /^The quarterly numbers look good\.\n\n\[\^c-[0-9a-f]{4}\]: 💬 on "quarterly numbers"\n\n {4}- \*\*@alice\*\* · 2026-11-11 12:00 — Source\?\n$/,
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

  test('reads two comment blocks as one and writes them back as one', () => {
    const state = stateFor('The quarterly numbers look good.\n');
    const first = createThread([], anchor, 'From Alice', alice).threads;
    const second = createThread([], { exact: 'look good' }, 'From Bob', bob).threads;
    const one = withThreads(state, first);
    const type = one.schema.nodes[GITQUIRE_COMMENTS_NODE];
    if (type === undefined) throw new Error('expected the comments node type');
    const block = type.create({ raw: serializeCommentTrailer(second) });
    const two = one.apply(one.tr.insert(one.doc.content.size, block));
    expect(countTrailers(two.doc)).toBe(2);
    const all = readThreads(two.doc);
    expect(all.map((thread) => thread.comments[0]?.body).sort()).toEqual([
      'From Alice',
      'From Bob',
    ]);
    const merged = withThreads(two, all);
    expect(countTrailers(merged.doc)).toBe(1);
    expect(readThreads(merged.doc)).toEqual(all);
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

  function commentOn(state: EditorState, quote: string, body: string) {
    const range = findQuoteRange(state.doc, quote);
    if (range === null) throw new Error(`quote not found: ${quote}`);
    const created = createThread(readThreads(state.doc), { exact: quote }, body, alice);
    return {
      thread: created.thread,
      state: withThreads(state, created.threads, { id: created.thread.id, pos: range.to }),
    };
  }

  test('a new comment puts a mark after the passage and highlights from it', () => {
    const { state, thread } = commentOn(
      stateFor('The quarterly numbers look good.\n'),
      'quarterly numbers',
      'Source?',
    );
    expect(md.serialize(state.doc.toJSON()).split('\n')[0]).toBe(
      `The quarterly numbers[^${thread.id}] look good.`,
    );
    const [placed] = placeThreads(state.doc, readThreads(state.doc));
    expect(placed?.marked).toBe(true);
    const range = placed?.range as { from: number; to: number };
    expect(state.doc.textBetween(range.from, range.to)).toBe('quarterly numbers');
  });

  test('the mark keeps the thread when the passage is reworded, and goes with deleted text', () => {
    const { state, thread } = commentOn(
      stateFor('The quarterly numbers look good.\n'),
      'quarterly numbers',
      'Source?',
    );
    const markPos = findMarks(state.doc).get(thread.id)?.[0] as number;
    const reworded = state.apply(state.tr.insertText('Q3 figures', 5, markPos));
    const [placed] = placeThreads(reworded.doc, readThreads(reworded.doc));
    expect(placed?.range).not.toBeNull();
    expect(findMarks(reworded.doc).has(thread.id)).toBe(true);
    const deleted = state.apply(state.tr.delete(1, markPos + 1));
    expect(findMarks(deleted.doc).has(thread.id)).toBe(false);
    expect(readThreads(deleted.doc)).toHaveLength(1);
  });

  test('resolving removes the mark and the thread', () => {
    const { state, thread } = commentOn(
      stateFor('The quarterly numbers look good.\n'),
      'quarterly numbers',
      'Source?',
    );
    const resolved = withThreads(state, setResolved(readThreads(state.doc), thread.id, true));
    expect(md.serialize(resolved.doc.toJSON())).toBe('The quarterly numbers look good.\n');
  });

  test('no mark in a heading or in code; the thread is found by its quote', () => {
    const state = stateFor('# Plan title\n\nSome `inline code` here.\n');
    const heading = commentOn(state, 'Plan title', 'Title?');
    expect(findMarks(heading.state.doc).size).toBe(0);
    expect(
      placeThreads(heading.state.doc, readThreads(heading.state.doc))[0]?.range,
    ).not.toBeNull();
    const code = findQuoteRange(state.doc, 'inline code');
    expect(code === null ? true : canPlaceMark(state.doc, code.to)).toBe(false);
  });
});
