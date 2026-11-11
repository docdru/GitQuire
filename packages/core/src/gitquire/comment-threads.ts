export const COMMENT_TRAILER_OPEN = '<!-- gitquire-comments v1';
export const COMMENT_TRAILER_CLOSE = '-->';

export interface CommentAuthor {
  id: string;
  login?: string;
  name?: string;
}

export interface CommentAnchor {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface ThreadComment {
  id: string;
  author: CommentAuthor;
  createdAt: string;
  editedAt?: string;
  body: string;
  mentions?: string[];
}

export interface CommentThread {
  id: string;
  anchor: CommentAnchor;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  comments: ThreadComment[];
}

export interface TrailerSplit {
  body: string;
  trailer: string | undefined;
}

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

function endsInsideFence(text: string): boolean {
  let open: string | undefined;
  for (const line of text.split('\n')) {
    const match = FENCE_LINE_RE.exec(line);
    if (match === null) continue;
    const marker = match[1] as string;
    if (open === undefined) {
      open = marker;
    } else if (marker[0] === open[0] && marker.length >= open.length) {
      open = undefined;
    }
  }
  return open !== undefined;
}

export function splitCommentTrailer(source: string): TrailerSplit {
  const normalizedEnd = source.replace(/[ \t\r\n]+$/, '');
  if (!normalizedEnd.endsWith(COMMENT_TRAILER_CLOSE)) return { body: source, trailer: undefined };
  const marker = `\n${COMMENT_TRAILER_OPEN}\n`;
  const atStart = normalizedEnd.startsWith(`${COMMENT_TRAILER_OPEN}\n`);
  const index = atStart ? 0 : normalizedEnd.lastIndexOf(marker) + 1;
  if (index === 0 && !atStart) return { body: source, trailer: undefined };
  const trailer = normalizedEnd.slice(index).replace(/\r\n/g, '\n');
  const inner = trailer.slice(COMMENT_TRAILER_OPEN.length, -COMMENT_TRAILER_CLOSE.length);
  if (inner.includes(COMMENT_TRAILER_CLOSE) || !inner.endsWith('\n')) {
    return { body: source, trailer: undefined };
  }
  const before = normalizedEnd.slice(0, index);
  if (endsInsideFence(before)) return { body: source, trailer: undefined };
  const trimmed = before.replace(/[ \t\r\n]+$/, '');
  return { body: trimmed === '' ? '' : `${trimmed}\n`, trailer };
}

export function joinCommentTrailer(body: string, trailer: string | undefined): string {
  if (trailer === undefined) return body;
  const trimmed = body.replace(/[ \t\r\n]+$/, '');
  return trimmed === '' ? `${trailer}\n` : `${trimmed}\n\n${trailer}\n`;
}

function encodeLine(value: unknown): string {
  return JSON.stringify(value).replace(/--/g, '-\\u002d').replace(/>/g, '\\u003e');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readAuthor(value: unknown): CommentAuthor | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  const author: CommentAuthor = { id: value.id };
  const login = optionalString(value.login);
  const name = optionalString(value.name);
  if (login !== undefined) author.login = login;
  if (name !== undefined) author.name = name;
  return author;
}

function readComment(value: unknown): ThreadComment | undefined {
  if (!isRecord(value)) return undefined;
  const author = readAuthor(value.author);
  if (
    typeof value.id !== 'string' ||
    author === undefined ||
    typeof value.createdAt !== 'string' ||
    typeof value.body !== 'string'
  ) {
    return undefined;
  }
  const comment: ThreadComment = {
    id: value.id,
    author,
    createdAt: value.createdAt,
    body: value.body,
  };
  const editedAt = optionalString(value.editedAt);
  if (editedAt !== undefined) comment.editedAt = editedAt;
  if (Array.isArray(value.mentions)) {
    comment.mentions = value.mentions.filter((m): m is string => typeof m === 'string');
  }
  return comment;
}

function readThread(value: unknown): CommentThread | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.anchor)) {
    return undefined;
  }
  if (typeof value.anchor.exact !== 'string' || !Array.isArray(value.comments)) return undefined;
  const anchor: CommentAnchor = { exact: value.anchor.exact };
  const prefix = optionalString(value.anchor.prefix);
  const suffix = optionalString(value.anchor.suffix);
  if (prefix !== undefined) anchor.prefix = prefix;
  if (suffix !== undefined) anchor.suffix = suffix;
  const comments = value.comments
    .map(readComment)
    .filter((c): c is ThreadComment => c !== undefined);
  if (comments.length === 0) return undefined;
  const thread: CommentThread = {
    id: value.id,
    anchor,
    resolved: value.resolved === true,
    comments,
  };
  const resolvedBy = optionalString(value.resolvedBy);
  const resolvedAt = optionalString(value.resolvedAt);
  if (resolvedBy !== undefined) thread.resolvedBy = resolvedBy;
  if (resolvedAt !== undefined) thread.resolvedAt = resolvedAt;
  return thread;
}

export interface ParsedTrailer {
  threads: CommentThread[];
  skippedLines: number;
}

export function parseCommentTrailer(trailer: string): ParsedTrailer {
  const lines = trailer.split('\n').slice(1, -1);
  const threads: CommentThread[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    const thread = readThread(parsed);
    if (thread === undefined) {
      skippedLines += 1;
    } else {
      threads.push(thread);
    }
  }
  return { threads, skippedLines };
}

export function serializeCommentTrailer(threads: readonly CommentThread[]): string | undefined {
  if (threads.length === 0) return undefined;
  const lines = threads.map((thread) => encodeLine(thread));
  return `${COMMENT_TRAILER_OPEN}\n${lines.join('\n')}\n${COMMENT_TRAILER_CLOSE}`;
}

export function readCommentThreads(markdown: string): CommentThread[] {
  const { trailer } = splitCommentTrailer(markdown);
  return trailer === undefined ? [] : parseCommentTrailer(trailer).threads;
}

export function writeCommentThreads(markdown: string, threads: readonly CommentThread[]): string {
  const { body } = splitCommentTrailer(markdown);
  return joinCommentTrailer(body, serializeCommentTrailer(threads));
}
