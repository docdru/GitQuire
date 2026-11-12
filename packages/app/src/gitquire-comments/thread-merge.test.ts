import { describe, expect, test } from 'vitest';
import {
  mergeThreads,
  notePendingWrite,
  PENDING_WRITE_WINDOW_MS,
  reconcileThreads,
  sameThreads,
} from './thread-merge';
import {
  addReply,
  createThread,
  deleteComment,
  editComment,
  type OpContext,
  setResolved,
  type Thread,
} from './thread-ops';

function context(login: string, id: number, time: string): OpContext {
  let counter = 0;
  let tick = 0;
  const start = Date.parse(time);
  return {
    author: { id: `github-${id}`, login, name: login },
    now: () => new Date(start + 1000 * tick++),
    newId: () => `${login}-${++counter}`,
  };
}

const alice = context('alice', 1, '2026-11-11T12:00:00Z');
const bob = context('bob', 2, '2026-11-11T12:30:00Z');
const anchor = { exact: 'quarterly numbers' };

function seed(): { base: Thread[]; threadId: string; commentId: string } {
  const { threads, thread } = createThread([], anchor, 'Source?', alice);
  return { base: threads, threadId: thread.id, commentId: thread.comments[0]?.id as string };
}

function bodies(threads: readonly Thread[]): string[][] {
  return threads.map((thread) => thread.comments.map((comment) => comment.body));
}

describe('mergeThreads', () => {
  test('keeps replies two people added to the same thread at once', () => {
    const { base, threadId } = seed();
    const mine = addReply(base, threadId, 'From Alice', alice);
    const theirs = addReply(base, threadId, 'From Bob', bob);
    expect(bodies(mergeThreads(base, mine, theirs))).toEqual([
      ['Source?', 'From Alice', 'From Bob'],
    ]);
  });

  test('keeps threads two people started at once', () => {
    const { base } = seed();
    const mine = createThread(base, { exact: 'look good' }, 'Mine', alice).threads;
    const theirs = createThread(base, { exact: 'numbers' }, 'Theirs', bob).threads;
    expect(bodies(mergeThreads(base, mine, theirs))).toEqual([['Source?'], ['Mine'], ['Theirs']]);
  });

  test('gives both sides the same result', () => {
    const { base, threadId } = seed();
    const withAliceThread = createThread(base, { exact: 'look good' }, 'Mine', alice).threads;
    const fromAlice = addReply(withAliceThread, threadId, 'From Alice', alice);
    const withBobThread = createThread(base, { exact: 'numbers' }, 'Theirs', bob).threads;
    const bobReplied = addReply(withBobThread, threadId, 'From Bob', bob);
    const fromBob = setResolved(bobReplied, threadId, true, bob);
    const seenByAlice = mergeThreads(base, fromAlice, fromBob);
    const seenByBob = mergeThreads(base, fromBob, fromAlice);
    expect(seenByAlice).toEqual(seenByBob);
    expect(sameThreads(mergeThreads(base, fromBob, seenByAlice), seenByAlice)).toBe(true);
    expect(sameThreads(mergeThreads(base, fromAlice, seenByBob), seenByBob)).toBe(true);
  });

  test('respects a deletion made by the other side', () => {
    const { base, threadId, commentId } = seed();
    const mine = addReply(base, threadId, 'Reply', alice);
    const theirs = deleteComment(base, threadId, commentId, alice.author);
    expect(bodies(mergeThreads(base, mine, theirs))).toEqual([['Reply']]);
    expect(mergeThreads(base, base, theirs)).toEqual([]);
  });

  test('takes an edit from either side and my resolve', () => {
    const { base, threadId, commentId } = seed();
    const mine = setResolved(base, threadId, true, alice);
    const theirs = editComment(base, threadId, commentId, 'Which source?', alice);
    const merged = mergeThreads(base, mine, theirs);
    expect(merged[0]).toMatchObject({ resolved: true, resolvedBy: 'alice' });
    expect(bodies(merged)).toEqual([['Which source?']]);
  });

  test('leaves a thread open when one side reopens and the other resolves', () => {
    const { base, threadId } = seed();
    const resolved = setResolved(base, threadId, true, alice);
    const mine = setResolved(resolved, threadId, false, alice);
    const theirs = setResolved(resolved, threadId, true, bob);
    expect(mergeThreads(resolved, mine, theirs)[0]?.resolved).toBe(false);
  });
});

describe('reconcileThreads', () => {
  test('writes a merge when a remote change dropped my comment', () => {
    const { base, threadId } = seed();
    const mine = addReply(base, threadId, 'From Alice', alice);
    const theirs = addReply(base, threadId, 'From Bob', bob);
    const pending = notePendingWrite([], base, mine, 1000);
    const result = reconcileThreads(pending, theirs, 1500);
    expect(bodies(result.write ?? [])).toEqual([['Source?', 'From Alice', 'From Bob']]);
    expect(reconcileThreads(result.pending, result.write ?? [], 1600).write).toBeUndefined();
  });

  test('does nothing when the remote state already has my change', () => {
    const { base, threadId } = seed();
    const mine = addReply(base, threadId, 'From Alice', alice);
    const pending = notePendingWrite([], base, mine, 1000);
    expect(reconcileThreads(pending, mine, 1500).write).toBeUndefined();
  });

  test('forgets a write once the window has passed', () => {
    const { base, threadId } = seed();
    const mine = addReply(base, threadId, 'From Alice', alice);
    const pending = notePendingWrite([], base, mine, 1000);
    const late = reconcileThreads(pending, base, 1001 + PENDING_WRITE_WINDOW_MS);
    expect(late).toEqual({ pending: [], write: undefined });
  });

  test('replays quick successive writes in order', () => {
    const { base, threadId } = seed();
    const first = addReply(base, threadId, 'One', alice);
    const second = addReply(first, threadId, 'Two', alice);
    const pending = notePendingWrite(notePendingWrite([], base, first, 1000), first, second, 2000);
    const stale = addReply(base, threadId, 'From Bob', bob);
    expect(bodies(reconcileThreads(pending, stale, 2500).write ?? [])).toEqual([
      ['Source?', 'One', 'Two', 'From Bob'],
    ]);
  });

  test('does not bring back a reply its author deleted after I wrote again', () => {
    const { base, threadId } = seed();
    const first = addReply(base, threadId, 'One', alice);
    let pending = notePendingWrite([], base, first, 0);
    const withBob = addReply(first, threadId, 'From Bob', bob);
    const bobReplyId = withBob[0]?.comments.at(-1)?.id as string;
    expect(reconcileThreads(pending, withBob, 5000).write).toBeUndefined();
    const second = addReply(withBob, threadId, 'Two', alice);
    pending = notePendingWrite(pending, withBob, second, 9000);
    const afterDelete = deleteComment(second, threadId, bobReplyId, bob.author);
    const result = reconcileThreads(pending, afterDelete, 14_000);
    expect(result.write).toBeUndefined();
    expect(result.pending).toHaveLength(1);
  });
});
