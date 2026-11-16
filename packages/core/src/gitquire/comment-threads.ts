import {
  commentLogin,
  type FenceState,
  type FootnoteAuthor,
  type FootnoteComment,
  type FootnoteThread,
  findCommentMarks,
  labelFromLegacyId,
  normalizeCommentTimes,
  parseCommentFootnotes,
  serializeCommentFootnotes,
  splitCommentFootnotes,
  stepFence,
  stripCommentMarks,
} from './comment-format.ts';

export const COMMENT_TRAILER_OPEN = '<!-- gitquire-comments v1';
export const COMMENT_TRAILER_CLOSE = '-->';

export type CommentAuthor = FootnoteAuthor;

export type CommentAnchor = FootnoteThread['anchor'];

export type ThreadComment = FootnoteComment;

export type CommentThread = FootnoteThread;

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

function extractStrayLegacyTrailers(body: string): StrayTrailers {
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
    const parsed = parseLegacyTrailer(block);
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

function mergeLegacyThreads(blocks: readonly string[]): CommentThread[] {
  const threads = new Map<string, CommentThread>();
  for (const block of blocks) {
    for (const thread of parseLegacyTrailer(block).threads) {
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

function splitLegacyTrailer(source: string): TrailerSplit {
  const final = splitFinalTrailer(source);
  if (!final.body.includes(COMMENT_TRAILER_OPEN)) return final;
  const stray = extractStrayLegacyTrailers(final.body);
  if (stray.blocks.length === 0) return final;
  const blocks = final.trailer === undefined ? stray.blocks : [...stray.blocks, final.trailer];
  const trimmed = trimTrailingSpace(stray.body);
  return {
    body: trimmed === '' ? '' : `${trimmed}\n`,
    trailer: serializeLegacyTrailer(mergeLegacyThreads(blocks)),
  };
}

export function joinCommentTrailer(body: string, trailer: string | undefined): string {
  if (trailer === undefined) return body;
  const trimmed = trimTrailingSpace(body);
  return trimmed === '' ? `${trailer}\n` : `${trimmed}\n\n${trailer}\n`;
}

function encodeLegacyLine(value: unknown): string {
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

interface LegacyParse extends ParsedTrailer {
  skipped: string[];
}

function parseLegacyTrailer(trailer: string): LegacyParse {
  const lines = trailer.split('\n').slice(1, -1);
  const threads: CommentThread[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push(line);
      continue;
    }
    const thread = readThread(parsed);
    if (thread === undefined) {
      skipped.push(line);
    } else {
      threads.push(thread);
    }
  }
  return { threads, skippedLines: skipped.length, skipped };
}

function serializeLegacyTrailer(threads: readonly CommentThread[]): string | undefined {
  if (threads.length === 0) return undefined;
  const lines = threads.map((thread) => encodeLegacyLine(thread));
  return `${COMMENT_TRAILER_OPEN}\n${lines.join('\n')}\n${COMMENT_TRAILER_CLOSE}`;
}

function legacyLogin(author: CommentAuthor): string {
  return commentLogin(author);
}

function convertLegacyThreads(legacy: LegacyParse, taken: Set<string>): CommentThread[] {
  const converted: CommentThread[] = [];
  for (const thread of legacy.threads) {
    if (thread.resolved) continue;
    const id = labelFromLegacyId(thread.id, taken);
    taken.add(id);
    const comments = thread.comments.map((comment) => {
      const login = legacyLogin(comment.author);
      const next: ThreadComment = normalizeCommentTimes({
        ...comment,
        author: { id: login.toLowerCase(), login },
      });
      return next;
    });
    const anchor: CommentAnchor = { exact: thread.anchor.exact };
    if (thread.anchor.prefix !== undefined) anchor.prefix = thread.anchor.prefix;
    if (thread.anchor.suffix !== undefined) anchor.suffix = thread.anchor.suffix;
    converted.push({ id, anchor, resolved: false, comments });
  }
  if (legacy.skipped.length > 0) {
    const id = labelFromLegacyId('unreadable-v1-lines', taken);
    taken.add(id);
    converted.push({
      id,
      anchor: { exact: '' },
      resolved: false,
      comments: [],
      unreadable: legacy.skipped,
    });
  }
  return converted;
}

const HEADING_LINE_RE = /^ {0,3}#{1,6}(\s|$)/;
const MARKUP_RE = /[*_`~]/g;

function plain(text: string): string {
  return text.replace(MARKUP_RE, '').replace(/\s+/g, ' ');
}

interface Candidate {
  offset: number;
  before: string;
  after: string;
}

const PROTECTED_SPAN_RES: readonly RegExp[] = [
  /(`+)[\s\S]*?\1/g,
  /\]\([^)]*\)/g,
  /\]\[[^\]]*\]/g,
  /\[\[[^\]]*\]\]/g,
  /<[^>]*>/g,
  /\$\$?[^$]*\$\$?/g,
  /\[\^[^\]]*\]/g,
  /https?:\/\/\S+/g,
];

function protectedSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const re of PROTECTED_SPAN_RES) {
    for (const match of line.matchAll(new RegExp(re.source, re.flags))) {
      const start = match.index ?? 0;
      spans.push([start, start + match[0].length]);
    }
  }
  return spans;
}

function markableCandidates(body: string, exact: string): Candidate[] {
  const candidates: Candidate[] = [];
  const lines = body.split('\n');
  let offset = 0;
  const fence: FenceState = { marker: undefined };
  let inFrontmatter = lines[0]?.trimEnd() === '---';
  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    offset += line.length + 1;
    if (inFrontmatter) {
      if (index > 0 && (line.trimEnd() === '---' || line.trimEnd() === '...'))
        inFrontmatter = false;
      continue;
    }
    if (stepFence(fence, line)) continue;
    if (HEADING_LINE_RE.test(line) || line.startsWith('    ') || line.trimStart().startsWith('<')) {
      continue;
    }
    const spans = protectedSpans(line);
    let at = line.indexOf(exact);
    while (at !== -1) {
      const end = at + exact.length;
      const blocked =
        spans.some(([from, to]) => at < to && end > from) || /[A-Za-z0-9]/.test(line[end] ?? '');
      if (!blocked) {
        candidates.push({
          offset: lineStart + end,
          before: body.slice(Math.max(0, lineStart + at - 200), lineStart + at),
          after: body.slice(lineStart + end, lineStart + end + 200),
        });
      }
      at = line.indexOf(exact, at + 1);
    }
  }
  return candidates;
}

function pickCandidate(
  candidates: readonly Candidate[],
  anchor: CommentAnchor,
): Candidate | undefined {
  if (candidates.length === 1) return candidates[0];
  const prefix = plain(anchor.prefix ?? '')
    .trim()
    .slice(-32);
  const suffix = plain(anchor.suffix ?? '')
    .trim()
    .slice(0, 32);
  if (prefix === '' && suffix === '') return undefined;
  const matching = candidates.filter((candidate) => {
    const before = plain(candidate.before).trimEnd();
    const after = plain(candidate.after).trimStart();
    return (
      (prefix === '' || before.endsWith(prefix)) && (suffix === '' || after.startsWith(suffix))
    );
  });
  return matching.length === 1 ? matching[0] : undefined;
}

export function insertCommentMarks(body: string, threads: readonly CommentThread[]): string {
  const inserts: Array<{ offset: number; label: string }> = [];
  const present = new Set(findCommentMarks(body));
  for (const thread of threads) {
    if (present.has(thread.id)) continue;
    const exact = thread.anchor.exact;
    if (exact.trim() === '' || exact.includes('\n')) continue;
    const chosen = pickCandidate(markableCandidates(body, exact), thread.anchor);
    if (chosen === undefined) continue;
    if (inserts.some((insert) => insert.offset === chosen.offset)) continue;
    inserts.push({ offset: chosen.offset, label: thread.id });
  }
  let next = body;
  for (const insert of inserts.sort((a, b) => b.offset - a.offset)) {
    next = `${next.slice(0, insert.offset)}[^${insert.label}]${next.slice(insert.offset)}`;
  }
  return next;
}

export interface CommentSplit extends TrailerSplit {
  converted: boolean;
}

export function splitCommentSource(source: string): CommentSplit {
  const legacy = splitLegacyTrailer(source);
  const footnotes = splitCommentFootnotes(legacy.body);
  if (legacy.trailer === undefined) {
    return {
      body: footnotes.body,
      trailer: footnotes.blocks.length === 0 ? undefined : footnotes.blocks.join('\n\n'),
      converted: false,
    };
  }
  const taken = new Set<string>(findCommentMarks(footnotes.body));
  for (const thread of parseCommentFootnotes(footnotes.blocks.join('\n\n')).threads) {
    taken.add(thread.id);
  }
  const converted = convertLegacyThreads(parseLegacyTrailer(legacy.trailer), taken);
  const body = insertCommentMarks(footnotes.body, converted);
  const parts = [serializeCommentFootnotes(converted), ...footnotes.blocks].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return { body, trailer: parts.length === 0 ? undefined : parts.join('\n\n'), converted: true };
}

export function splitCommentTrailer(source: string): TrailerSplit {
  const { body, trailer } = splitCommentSource(source);
  return { body, trailer };
}

export function parseCommentTrailer(trailer: string): ParsedTrailer {
  if (!trailer.includes(COMMENT_TRAILER_OPEN)) return parseCommentFootnotes(trailer);
  const legacy = splitLegacyTrailer(trailer);
  const footnotes = parseCommentFootnotes(legacy.body);
  if (legacy.trailer === undefined) return footnotes;
  const taken = new Set(footnotes.threads.map((thread) => thread.id));
  const converted = convertLegacyThreads(parseLegacyTrailer(legacy.trailer), taken);
  return {
    threads: [...converted, ...footnotes.threads],
    skippedLines:
      footnotes.skippedLines + converted.reduce((n, t) => n + (t.unreadable?.length ?? 0), 0),
  };
}

export function serializeCommentTrailer(threads: readonly CommentThread[]): string | undefined {
  return serializeCommentFootnotes(threads);
}

export function readCommentThreads(markdown: string): CommentThread[] {
  const { trailer } = splitCommentSource(markdown);
  return trailer === undefined ? [] : parseCommentTrailer(trailer).threads;
}

export function writeCommentThreads(markdown: string, threads: readonly CommentThread[]): string {
  const { body } = splitCommentSource(markdown);
  return joinCommentTrailer(body, serializeCommentTrailer(threads));
}

export function pageTextWithoutComments(markdown: string): string {
  const { body, trailer } = splitCommentSource(markdown);
  if (trailer === undefined) return body;
  const labels = new Set(parseCommentTrailer(trailer).threads.map((thread) => thread.id));
  return stripCommentMarks(body, labels);
}

export function convertCommentsToFootnotes(markdown: string): string {
  const split = splitCommentSource(markdown);
  if (!split.converted) return markdown;
  return joinCommentTrailer(split.body, split.trailer);
}

export {
  COMMENT_LABEL_PREFIX,
  commentIdFor,
  commentLogin,
  extractMentions,
  findCommentMarks,
  formatStamp,
  isCommentLabel,
  newCommentLabel,
  normalizeCommentTimes,
  secondIso,
  stripCommentMarks,
} from './comment-format.ts';

export function normalizeComments(markdown: string): string {
  const split = splitCommentSource(markdown);
  if (split.trailer === undefined) return markdown;
  return joinCommentTrailer(
    split.body,
    serializeCommentTrailer(parseCommentTrailer(split.trailer).threads),
  );
}
