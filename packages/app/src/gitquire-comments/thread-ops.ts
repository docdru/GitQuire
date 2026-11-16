import {
  type CommentAnchor,
  type CommentAuthor,
  type CommentThread,
  commentIdFor,
  commentLogin,
  newCommentLabel,
  normalizeCommentTimes,
  type ThreadComment as StoredComment,
  secondIso,
} from '@gitquire/core/gitquire/comment-threads';

export type Thread = CommentThread;
export type ThreadComment = StoredComment;
export type Author = CommentAuthor;
export type Anchor = CommentAnchor;

export interface OpContext {
  author: Author;
  now: () => Date;
  newId: () => string;
}

const MENTION_RE = /(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\w-])/g;

export interface TextSegment {
  start: number;
  text: string;
  mention: boolean;
}

export function segmentMentions(body: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(MENTION_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ start: cursor, text: body.slice(cursor, index), mention: false });
    }
    segments.push({ start: index, text: match[0], mention: true });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) {
    segments.push({ start: cursor, text: body.slice(cursor), mention: false });
  }
  return segments;
}

export function extractMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    seen.add((match[1] as string).toLowerCase());
  }
  return [...seen];
}

function stamp(ctx: OpContext, iso: string = ctx.now().toISOString()): string {
  return normalizeCommentTimes({ id: '', author: ctx.author, createdAt: iso, body: '' }).createdAt;
}

function authorOf(ctx: OpContext): Author {
  const login = commentLogin(ctx.author);
  return { id: login.toLowerCase(), login };
}

function sameAuthorAt(
  existing: readonly ThreadComment[],
  login: string,
  createdAt: string,
): number {
  return existing.filter(
    (comment) =>
      comment.createdAt === createdAt &&
      commentLogin(comment.author).toLowerCase() === login.toLowerCase(),
  ).length;
}

function newComment(
  body: string,
  ctx: OpContext,
  threadId: string,
  existing: readonly ThreadComment[],
): ThreadComment {
  const author = authorOf(ctx);
  const login = author.login as string;
  const now = ctx.now().toISOString();
  let createdAt = stamp(ctx, now);
  if (sameAuthorAt(existing, login, createdAt) > 0) createdAt = secondIso(now);
  const comment: ThreadComment = {
    id: commentIdFor(threadId, login, createdAt, sameAuthorAt(existing, login, createdAt)),
    author,
    createdAt,
    body,
  };
  const mentions = extractMentions(body);
  if (mentions.length > 0) comment.mentions = mentions;
  return comment;
}

export function createThread(
  threads: readonly Thread[],
  anchor: Anchor,
  body: string,
  ctx: OpContext,
): { threads: Thread[]; thread: Thread } {
  const id = newCommentLabel(new Set(threads.map((existing) => existing.id)));
  const thread: Thread = {
    id,
    anchor,
    resolved: false,
    comments: [newComment(body, ctx, id, [])],
  };
  return { threads: [...threads, thread], thread };
}

function updateThread(
  threads: readonly Thread[],
  threadId: string,
  update: (thread: Thread) => Thread | undefined,
): Thread[] {
  const next: Thread[] = [];
  for (const thread of threads) {
    if (thread.id !== threadId) {
      next.push(thread);
      continue;
    }
    const updated = update(thread);
    if (updated !== undefined) next.push(updated);
  }
  return next;
}

export function addReply(
  threads: readonly Thread[],
  threadId: string,
  body: string,
  ctx: OpContext,
): Thread[] {
  return updateThread(threads, threadId, (thread) => ({
    ...thread,
    comments: [...thread.comments, newComment(body, ctx, thread.id, thread.comments)],
  }));
}

export function setResolved(
  threads: readonly Thread[],
  threadId: string,
  resolved: boolean,
): Thread[] {
  if (!resolved) return [...threads];
  return threads.filter((thread) => thread.id !== threadId);
}

function loginOf(author: Author): string {
  return commentLogin(author).toLowerCase();
}

export function canModify(comment: ThreadComment, author: Author): boolean {
  return loginOf(comment.author) === loginOf(author);
}

export function editComment(
  threads: readonly Thread[],
  threadId: string,
  commentId: string,
  body: string,
  ctx: OpContext,
): Thread[] {
  return updateThread(threads, threadId, (thread) => ({
    ...thread,
    comments: thread.comments.map((comment) => {
      if (comment.id !== commentId || !canModify(comment, ctx.author)) return comment;
      const edited: ThreadComment = {
        ...comment,
        body,
        editedAt: stamp(ctx),
      };
      const mentions = extractMentions(body);
      if (mentions.length > 0) {
        edited.mentions = mentions;
      } else {
        delete edited.mentions;
      }
      return edited;
    }),
  }));
}

export function deleteComment(
  threads: readonly Thread[],
  threadId: string,
  commentId: string,
  author: Author,
): Thread[] {
  return updateThread(threads, threadId, (thread) => {
    const comments = thread.comments.filter(
      (comment) => comment.id !== commentId || !canModify(comment, author),
    );
    return comments.length === 0 ? undefined : { ...thread, comments };
  });
}

export function compareThreads(a: Thread, b: Thread): number {
  if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
  const at = a.comments[0]?.createdAt ?? '';
  const bt = b.comments[0]?.createdAt ?? '';
  return at.localeCompare(bt);
}

export type EditOutcome =
  | { kind: 'unchanged' }
  | { kind: 'empty' }
  | { kind: 'save'; body: string };

export function editOutcome(draft: string, original: string): EditOutcome {
  const body = draft.trim();
  if (body === '') return { kind: 'empty' };
  if (body === original) return { kind: 'unchanged' };
  return { kind: 'save', body };
}

export function hasCommentBody(
  threads: readonly Thread[],
  threadId: string,
  commentId: string,
  body: string,
): boolean {
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) return false;
  return thread.comments.some((comment) => comment.id === commentId && comment.body === body);
}
