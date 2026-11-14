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

const TRAILING_SPACE = new Set([' ', '\t', '\r', '\n']);

function trimTrailingSpace(text: string): string {
  let end = text.length;
  while (end > 0 && TRAILING_SPACE.has(text[end - 1] as string)) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

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

function splitFinalTrailer(source: string): TrailerSplit {
  const normalizedEnd = trimTrailingSpace(source);
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
  const trimmed = trimTrailingSpace(before);
  return { body: trimmed === '' ? '' : `${trimmed}\n`, trailer };
}

function isTrailerOpenLine(line: string): boolean {
  return trimTrailingSpace(line) === COMMENT_TRAILER_OPEN;
}

function isTrailerCloseLine(line: string): boolean {
  return trimTrailingSpace(line) === COMMENT_TRAILER_CLOSE;
}

interface StrayTrailers {
  body: string;
  blocks: string[];
}

function extractStrayTrailers(body: string): StrayTrailers {
  const lines = body.split('\n');
  const kept: string[] = [];
  const blocks: string[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const fenceMatch = FENCE_LINE_RE.exec(line);
    if (fence !== undefined) {
      const marker = fenceMatch?.[1];
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      kept.push(line);
      continue;
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1];
      kept.push(line);
      continue;
    }
    if (!isTrailerOpenLine(line)) {
      kept.push(line);
      continue;
    }
    let close = index + 1;
    while (close < lines.length && !isTrailerCloseLine(lines[close] as string)) close += 1;
    if (close >= lines.length) {
      kept.push(line);
      continue;
    }
    const block = [COMMENT_TRAILER_OPEN, ...lines.slice(index + 1, close).map(trimTrailingSpace)]
      .concat(COMMENT_TRAILER_CLOSE)
      .join('\n');
    const parsed = parseCommentTrailer(block);
    if (parsed.threads.length === 0 || parsed.skippedLines > 0) {
      kept.push(line);
      continue;
    }
    blocks.push(block);
    index = close;
    const previous = kept[kept.length - 1];
    const next = lines[index + 1];
    if ((previous === undefined || previous.trim() === '') && next?.trim() === '') {
      index += 1;
    }
  }
  return { body: kept.join('\n'), blocks };
}

function mergeThreads(blocks: readonly string[]): CommentThread[] {
  const threads = new Map<string, CommentThread>();
  for (const block of blocks) {
    for (const thread of parseCommentTrailer(block).threads) {
      const existing = threads.get(thread.id);
      if (existing === undefined) {
        threads.set(thread.id, { ...thread, comments: [...thread.comments] });
        continue;
      }
      const comments = new Map(existing.comments.map((comment) => [comment.id, comment]));
      for (const comment of thread.comments) comments.set(comment.id, comment);
      threads.set(thread.id, {
        ...thread,
        comments: [...comments.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      });
    }
  }
  return [...threads.values()];
}

export function splitCommentTrailer(source: string): TrailerSplit {
  const final = splitFinalTrailer(source);
  if (!final.body.includes(COMMENT_TRAILER_OPEN)) return final;
  const stray = extractStrayTrailers(final.body);
  if (stray.blocks.length === 0) return final;
  const blocks = final.trailer === undefined ? stray.blocks : [...stray.blocks, final.trailer];
  const trimmed = trimTrailingSpace(stray.body);
  return {
    body: trimmed === '' ? '' : `${trimmed}\n`,
    trailer: serializeCommentTrailer(mergeThreads(blocks)),
  };
}

export function joinCommentTrailer(body: string, trailer: string | undefined): string {
  if (trailer === undefined) return body;
  const trimmed = trimTrailingSpace(body);
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
