import {
  parseCommentTrailer,
  serializeCommentTrailer,
} from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import type { Thread, ThreadComment } from './thread-ops';

function normalizeThreads(threads: readonly Thread[]): Thread[] {
  const raw = serializeCommentTrailer(threads);
  return raw === undefined ? [] : parseCommentTrailer(raw).threads;
}

function canonical(threads: readonly Thread[]): string | undefined {
  return serializeCommentTrailer(normalizeThreads(threads));
}

export function sameThreads(a: readonly Thread[], b: readonly Thread[]): boolean {
  return canonical(a) === canonical(b);
}

function commentKey(comment: ThreadComment | undefined): string {
  if (comment === undefined) return '';
  return JSON.stringify([
    comment.author.id,
    comment.createdAt,
    comment.editedAt ?? null,
    comment.body,
  ]);
}

interface ThreadState {
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
}

function stateKey(thread: Thread | undefined): string {
  if (thread === undefined) return '';
  return JSON.stringify([thread.resolved, thread.resolvedBy ?? null, thread.resolvedAt ?? null]);
}

function later<T>(
  a: T,
  b: T,
  aTime: string | undefined,
  bTime: string | undefined,
  key: (value: T) => string,
): T {
  const aStamp = aTime ?? '';
  const bStamp = bTime ?? '';
  if (aStamp !== bStamp) return aStamp > bStamp ? a : b;
  return key(a) >= key(b) ? a : b;
}

function mergeComment(
  base: ThreadComment | undefined,
  mine: ThreadComment | undefined,
  theirs: ThreadComment | undefined,
): ThreadComment | undefined {
  const baseKey = commentKey(base);
  if (commentKey(mine) === baseKey) return theirs;
  if (commentKey(theirs) === baseKey) return mine;
  if (mine === undefined) return theirs;
  if (theirs === undefined) return mine;
  return later(mine, theirs, mine.editedAt, theirs.editedAt, commentKey);
}

function mergeState(
  base: Thread | undefined,
  mine: Thread | undefined,
  theirs: Thread | undefined,
): ThreadState {
  const fallback = theirs ?? mine ?? { resolved: false };
  if (mine === undefined || theirs === undefined) return fallback;
  const baseKey = stateKey(base);
  if (stateKey(mine) === baseKey) return theirs;
  if (stateKey(theirs) === baseKey) return mine;
  if (!mine.resolved) return mine;
  if (!theirs.resolved) return theirs;
  return later(mine, theirs, mine.resolvedAt, theirs.resolvedAt, stateKey);
}

function byId<T extends { id: string }>(items: readonly T[] | undefined): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items ?? []) map.set(item.id, item);
  return map;
}

function unionIds(
  first: readonly { id: string }[] | undefined,
  second: readonly { id: string }[] | undefined,
): string[] {
  const ids = new Set<string>();
  for (const item of first ?? []) ids.add(item.id);
  for (const item of second ?? []) ids.add(item.id);
  return [...ids];
}

function compareComments(a: ThreadComment, b: ThreadComment): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function compareThreadOrder(a: Thread, b: Thread): number {
  const aStart = a.comments[0]?.createdAt ?? '';
  const bStart = b.comments[0]?.createdAt ?? '';
  if (aStart !== bStart) return aStart < bStart ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function mergeThread(
  base: Thread | undefined,
  mine: Thread | undefined,
  theirs: Thread | undefined,
): Thread | undefined {
  const source = theirs ?? mine;
  if (source === undefined) return undefined;
  const baseComments = byId(base?.comments);
  const mineComments = byId(mine?.comments);
  const theirComments = byId(theirs?.comments);
  const comments: ThreadComment[] = [];
  for (const id of unionIds(theirs?.comments, mine?.comments)) {
    const merged = mergeComment(baseComments.get(id), mineComments.get(id), theirComments.get(id));
    if (merged !== undefined) comments.push(merged);
  }
  if (comments.length === 0) return undefined;
  comments.sort(compareComments);
  const state = mergeState(base, mine, theirs);
  const thread: Thread = {
    id: source.id,
    anchor: source.anchor,
    resolved: state.resolved,
    comments,
  };
  if (state.resolved && state.resolvedBy !== undefined) thread.resolvedBy = state.resolvedBy;
  if (state.resolved && state.resolvedAt !== undefined) thread.resolvedAt = state.resolvedAt;
  return thread;
}

export function mergeThreads(
  base: readonly Thread[],
  mine: readonly Thread[],
  theirs: readonly Thread[],
): Thread[] {
  const baseThreads = byId(base);
  const mineThreads = byId(mine);
  const theirThreads = byId(theirs);
  const merged: Thread[] = [];
  for (const id of unionIds(theirs, mine)) {
    const thread = mergeThread(baseThreads.get(id), mineThreads.get(id), theirThreads.get(id));
    if (thread !== undefined) merged.push(thread);
  }
  return normalizeThreads(merged.sort(compareThreadOrder));
}

export const PENDING_WRITE_WINDOW_MS = 10_000;

export interface PendingWrite {
  base: readonly Thread[];
  mine: readonly Thread[];
  at: number;
}

function stillPending(pending: readonly PendingWrite[], now: number): PendingWrite[] {
  return pending.filter((write) => now - write.at <= PENDING_WRITE_WINDOW_MS);
}

export function notePendingWrite(
  pending: readonly PendingWrite[],
  base: readonly Thread[],
  mine: readonly Thread[],
  now: number,
): PendingWrite[] {
  return [...stillPending(pending, now), { base, mine, at: now }];
}

interface Reconciliation {
  pending: PendingWrite[];
  write: Thread[] | undefined;
}

export function reconcileThreads(
  pending: readonly PendingWrite[],
  theirs: readonly Thread[],
  now: number,
): Reconciliation {
  const live = stillPending(pending, now);
  let merged: readonly Thread[] = theirs;
  for (const write of live) merged = mergeThreads(write.base, write.mine, merged);
  return { pending: live, write: sameThreads(merged, theirs) ? undefined : [...merged] };
}
