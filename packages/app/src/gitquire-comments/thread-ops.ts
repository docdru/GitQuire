import type {
  CommentAnchor,
  CommentAuthor,
  CommentThread,
  ThreadComment as StoredComment,
} from '@inkeep/open-knowledge-core/gitquire/comment-threads';

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

function newComment(body: string, ctx: OpContext): ThreadComment {
  const comment: ThreadComment = {
    id: ctx.newId(),
    author: ctx.author,
    createdAt: ctx.now().toISOString(),
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
  const thread: Thread = {
    id: ctx.newId(),
    anchor,
    resolved: false,
    comments: [newComment(body, ctx)],
  };
  return { threads: [...threads, thread], thread };
}

function reopened(thread: Thread): Thread {
  return { id: thread.id, anchor: thread.anchor, resolved: false, comments: thread.comments };
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
    ...reopened(thread),
    comments: [...thread.comments, newComment(body, ctx)],
  }));
}

export function setResolved(
  threads: readonly Thread[],
  threadId: string,
  resolved: boolean,
  ctx: OpContext,
): Thread[] {
  return updateThread(threads, threadId, (thread) => {
    if (!resolved) return reopened(thread);
    return {
      ...thread,
      resolved: true,
      resolvedBy: ctx.author.login ?? ctx.author.id,
      resolvedAt: ctx.now().toISOString(),
    };
  });
}

export function canModify(comment: ThreadComment, author: Author): boolean {
  return comment.author.id === author.id;
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
        editedAt: ctx.now().toISOString(),
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
