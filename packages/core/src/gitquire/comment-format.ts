export const COMMENT_LABEL_PREFIX = 'c-';

const COMMENT_HEADER_ICON = '💬';

export interface FootnoteAuthor {
  id: string;
  login?: string;
  name?: string;
}

export interface FootnoteComment {
  id: string;
  author: FootnoteAuthor;
  createdAt: string;
  editedAt?: string;
  body: string;
  mentions?: string[];
}

export interface FootnoteThread {
  id: string;
  anchor: { exact: string; prefix?: string; suffix?: string };
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  comments: FootnoteComment[];
  unreadable?: string[];
}

export interface ParsedFootnotes {
  threads: FootnoteThread[];
  skippedLines: number;
}

export interface FootnoteSplit {
  body: string;
  blocks: string[];
}

const LABEL_BODY = '[A-Za-z0-9]+';
const DEFINITION_START_RE = new RegExp(
  `^ {0,3}\\[\\^(${COMMENT_LABEL_PREFIX}${LABEL_BODY})\\]:(.*)$`,
);
const MARK_RE = new RegExp(`\\[\\^(${COMMENT_LABEL_PREFIX}${LABEL_BODY})\\]`, 'g');
const LABEL_RE = new RegExp(`^${COMMENT_LABEL_PREFIX}${LABEL_BODY}$`);
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const THREAD_LINE_RE = /^\s*- (?:\*\*)?@[A-Za-z0-9]/;
const LOGIN_PART = '@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)';
const STAMP_PART = '(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}(?::\\d{2})?)';
const COMMENT_LINE_RE = new RegExp(
  `^(?:\\*\\*)?${LOGIN_PART}(?:\\*\\*)?(?:\\s*·\\s*${STAMP_PART})?(?:\\s*·\\s*edited\\s+${STAMP_PART})?(?:\\s*(?:—|–|:|-)\\s*|\\s+|$)([\\s\\S]*)$`,
);
const LOOSE_COMMENT_LINE_RE = /^- (?:\*\*)?@[A-Za-z0-9]/;
const MENTION_RE = /(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\w-])/g;

const LOGIN_MAX = 39;

export function commentLogin(author: { id: string; login?: string; name?: string }): string {
  const raw = author.login ?? author.name ?? author.id;
  const safe = raw
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, LOGIN_MAX)
    .replace(/-+$/, '');
  return safe === '' ? 'unknown' : safe;
}

export function isCommentLabel(label: string): boolean {
  return LABEL_RE.test(label);
}

function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trimEnd() !== '---') return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] as string).trimEnd();
    if (line === '---' || line === '...') return index + 1;
  }
  return 0;
}

function continuesDefinition(line: string): boolean {
  return indentWidth(line) >= 1 || LOOSE_COMMENT_LINE_RE.test(line);
}

export interface FenceState {
  marker: string | undefined;
}

export function stepFence(state: FenceState, line: string): boolean {
  const match = FENCE_LINE_RE.exec(line.replace(/\r$/, ''));
  if (state.marker !== undefined) {
    const marker = match?.[1];
    if (
      marker !== undefined &&
      marker[0] === state.marker[0] &&
      marker.length >= state.marker.length &&
      (match?.[2] ?? '').trim() === ''
    ) {
      state.marker = undefined;
    }
    return true;
  }
  if (match === null) return false;
  if (match[1]?.[0] === '`' && (match[2] ?? '').includes('`')) return false;
  state.marker = match[1];
  return true;
}

function parseHeader(text: string): string | undefined {
  if (!text.startsWith(COMMENT_HEADER_ICON)) return undefined;
  const rest = text.slice(COMMENT_HEADER_ICON.length).trim();
  if (rest === '' || rest === 'comment') return '';
  if (!/^on\s/.test(rest)) return undefined;
  const quoted = rest.slice(2).trim();
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return undefined;
  const inner = quoted.slice(1, -1);
  let escaped = false;
  for (const char of inner) {
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"') return undefined;
  }
  return escaped ? undefined : unquote(inner);
}

function isThreadBlock(block: readonly string[]): boolean {
  const first = DEFINITION_START_RE.exec(block[0] ?? '');
  if (first === null) return false;
  const head = (first[2] ?? '').trim();
  if (parseHeader(head) !== undefined) return true;
  return [head, ...block.slice(1)].some((line) => THREAD_LINE_RE.test(line));
}

function trimEndSpace(text: string): string {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1] as string)) end -= 1;
  return text.slice(0, end);
}

export function splitCommentFootnotes(source: string): FootnoteSplit {
  if (!source.includes(`[^${COMMENT_LABEL_PREFIX}`)) return { body: source, blocks: [] };
  const lines = source.split('\n');
  const clean = lines.map((line) => line.replace(/\r$/, ''));
  const kept: string[] = [];
  const blocks: string[] = [];
  const start = frontmatterEnd(clean);
  for (let index = 0; index < start; index += 1) kept.push(lines[index] as string);
  const fence: FenceState = { marker: undefined };
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const text = clean[index] as string;
    if (stepFence(fence, text) || !DEFINITION_START_RE.test(text)) {
      kept.push(line);
      continue;
    }
    const block = [text.replace(/^ {0,3}/, '')];
    let next = index + 1;
    while (next < lines.length) {
      const candidate = clean[next] as string;
      if (DEFINITION_START_RE.test(candidate)) break;
      if (!isBlank(candidate)) {
        if (!continuesDefinition(candidate)) break;
        block.push(candidate);
        next += 1;
        continue;
      }
      let lookahead = next;
      while (lookahead < lines.length && isBlank(clean[lookahead] as string)) lookahead += 1;
      const after = clean[lookahead];
      if (after === undefined || DEFINITION_START_RE.test(after) || indentWidth(after) < 1) {
        break;
      }
      for (let blank = next; blank < lookahead; blank += 1) block.push('');
      next = lookahead;
    }
    if (!isThreadBlock(block)) {
      for (let original = index; original < next; original += 1)
        kept.push(lines[original] as string);
      index = next - 1;
      continue;
    }
    blocks.push(block.join('\n'));
    if (kept.length === 0 || isBlank(kept[kept.length - 1] as string)) {
      while (next < lines.length && isBlank(clean[next] as string)) next += 1;
    }
    index = next - 1;
  }
  if (blocks.length === 0) return { body: source, blocks };
  const body = trimEndSpace(kept.join('\n'));
  return {
    body: body === '' ? '' : `${body}\n`,
    blocks,
  };
}

export function extractMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) seen.add((match[1] as string).toLowerCase());
  return [...seen];
}

function stampToIso(date: string | undefined, time: string | undefined): string | undefined {
  if (date === undefined || time === undefined) return undefined;
  return `${date}T${time.length === 5 ? `${time}:00` : time}.000Z`;
}

export function formatStamp(iso: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (match === null) return undefined;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return `${match[1]} ${match[2]}`;
  const utc = parsed.toISOString();
  const seconds = utc.slice(17, 19);
  return `${utc.slice(0, 10)} ${utc.slice(11, 16)}${seconds === '00' ? '' : `:${seconds}`}`;
}

function truncatedIso(iso: string, precision: 'minute' | 'second'): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const utc = parsed.toISOString();
  return precision === 'minute' ? `${utc.slice(0, 16)}:00.000Z` : `${utc.slice(0, 19)}.000Z`;
}

export function secondIso(iso: string): string {
  return truncatedIso(iso, 'second');
}

function minuteIso(iso: string): string {
  return truncatedIso(iso, 'minute');
}

function unquote(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

function quote(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

interface CommentDraft {
  login: string;
  createdAt: string;
  editedAt?: string;
  lines: string[];
}

function parseCommentLine(text: string): CommentDraft | undefined {
  const match = COMMENT_LINE_RE.exec(text);
  if (match === null) return undefined;
  const login = match[1] as string;
  const createdAt = stampToIso(match[2], match[3]) ?? '';
  const editedAt = stampToIso(match[4], match[5]);
  const first = (match[6] ?? '').trim();
  if (first === '' && createdAt === '') return undefined;
  const draft: CommentDraft = { login, createdAt, lines: [first] };
  if (editedAt !== undefined) draft.editedAt = editedAt;
  return draft;
}

function finishComment(
  draft: CommentDraft,
  threadId: string,
  seen: Map<string, number>,
): FootnoteComment {
  while (draft.lines.length > 1 && isBlank(draft.lines[draft.lines.length - 1] as string)) {
    draft.lines.pop();
  }
  const body = draft.lines.join('\n').trim();
  const key = `${draft.login.toLowerCase()}@${draft.createdAt}`;
  const count = seen.get(key) ?? 0;
  seen.set(key, count + 1);
  const comment: FootnoteComment = {
    id: commentIdFor(threadId, draft.login, draft.createdAt, count),
    author: { id: draft.login.toLowerCase(), login: draft.login },
    createdAt: draft.createdAt,
    body,
  };
  if (draft.editedAt !== undefined) comment.editedAt = draft.editedAt;
  const mentions = extractMentions(body);
  if (mentions.length > 0) comment.mentions = mentions;
  return comment;
}

export function commentIdFor(
  threadId: string,
  login: string,
  createdAt: string,
  occurrence: number,
): string {
  const base = `${threadId}/${login.toLowerCase()}/${createdAt === '' ? 'undated' : createdAt}`;
  return occurrence === 0 ? base : `${base}/${occurrence + 1}`;
}

function parseDefinition(block: string): { thread: FootnoteThread; skipped: number } | undefined {
  const lines = block.split('\n');
  const first = DEFINITION_START_RE.exec(lines[0] ?? '');
  if (first === null) return undefined;
  const id = first[1] as string;
  const thread: FootnoteThread = { id, anchor: { exact: '' }, resolved: false, comments: [] };
  const unreadable: string[] = [];
  const seen = new Map<string, number>();
  let current: CommentDraft | undefined;
  const flush = () => {
    if (current !== undefined) {
      const draft = current;
      const body = draft.lines.join('\n').trim();
      const duplicate = thread.comments.some(
        (comment) =>
          comment.author.login === draft.login &&
          comment.createdAt === draft.createdAt &&
          comment.body === body,
      );
      if (!duplicate) thread.comments.push(finishComment(draft, id, seen));
    }
    current = undefined;
  };
  let currentIndent = 0;
  const readLine = (text: string, width: number): void => {
    if (width <= 4 && text.startsWith('- ')) {
      flush();
      const parsed = parseCommentLine(text.slice(2));
      if (parsed === undefined) {
        unreadable.push(text);
      } else {
        current = parsed;
        currentIndent = width;
      }
      return;
    }
    if (current !== undefined && width > currentIndent) {
      current.lines.push(text);
      return;
    }
    flush();
    unreadable.push(text);
  };
  const headText = (first[2] ?? '').trim();
  const header = parseHeader(headText);
  if (header !== undefined) {
    thread.anchor = { exact: header };
  } else if (headText !== '') {
    readLine(headText, 0);
  }
  for (const raw of lines.slice(1)) {
    if (isBlank(raw)) {
      if (current !== undefined) current.lines.push('');
      continue;
    }
    readLine(raw.trimStart(), indentWidth(raw));
  }
  flush();
  if (unreadable.length > 0) thread.unreadable = unreadable;
  return { thread, skipped: unreadable.length };
}

function joinSameLabel(blocks: readonly string[]): string[] {
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const block of blocks) {
    const label = DEFINITION_START_RE.exec(block.split('\n')[0] ?? '')?.[1];
    if (label === undefined) continue;
    const lines = block.split('\n');
    const existing = grouped.get(label);
    if (existing === undefined) {
      grouped.set(label, lines);
      order.push(label);
      continue;
    }
    const head = (DEFINITION_START_RE.exec(lines[0] ?? '')?.[2] ?? '').trim();
    if (head !== '' && parseHeader(head) === undefined) existing.push(`    ${head}`);
    existing.push(...lines.slice(1));
  }
  return order.map((label) => (grouped.get(label) as string[]).join('\n'));
}

export function parseCommentFootnotes(text: string): ParsedFootnotes {
  const { blocks } = splitCommentFootnotes(text);
  const threads: FootnoteThread[] = [];
  let skippedLines = 0;
  for (const block of joinSameLabel(blocks)) {
    const parsed = parseDefinition(block);
    if (parsed === undefined) continue;
    skippedLines += parsed.skipped;
    threads.push(parsed.thread);
  }
  return { threads, skippedLines };
}

function serializeComment(comment: FootnoteComment): string[] {
  const login = comment.author.login ?? comment.author.id;
  const parts = [`**@${login}**`];
  const created = comment.createdAt === '' ? undefined : formatStamp(comment.createdAt);
  if (created !== undefined) parts.push(created);
  const edited = comment.editedAt === undefined ? undefined : formatStamp(comment.editedAt);
  if (edited !== undefined) parts.push(`edited ${edited}`);
  const [firstLine = '', ...rest] = comment.body.trim().split('\n');
  const head = `    - ${parts.join(' · ')} — ${firstLine.trimEnd()}`;
  return [head, ...rest.map((line) => (isBlank(line) ? '' : `      ${line.trimEnd()}`))];
}

function serializeThread(thread: FootnoteThread): string {
  const exact = thread.anchor.exact.trim();
  const header =
    exact === '' ? `${COMMENT_HEADER_ICON} comment` : `${COMMENT_HEADER_ICON} on "${quote(exact)}"`;
  const lines = [`[^${thread.id}]: ${header}`, ''];
  for (const comment of thread.comments) lines.push(...serializeComment(comment));
  for (const line of thread.unreadable ?? []) lines.push(`    ${line}`);
  return lines.join('\n');
}

export function serializeCommentFootnotes(threads: readonly FootnoteThread[]): string | undefined {
  const kept = threads.filter(
    (thread) =>
      !thread.resolved && (thread.comments.length > 0 || (thread.unreadable ?? []).length > 0),
  );
  if (kept.length === 0) return undefined;
  return kept.map(serializeThread).join('\n\n');
}

export function normalizeCommentTimes<T extends FootnoteComment>(comment: T): T {
  const next = {
    ...comment,
    createdAt: comment.createdAt === '' ? '' : minuteIso(comment.createdAt),
  };
  if (comment.editedAt !== undefined) next.editedAt = minuteIso(comment.editedAt);
  return next;
}

export function findCommentMarks(text: string): string[] {
  return [...text.matchAll(MARK_RE)].map((match) => match[1] as string);
}

export function stripCommentMarks(text: string, labels?: ReadonlySet<string>): string {
  return text.replace(MARK_RE, (whole, label: string) =>
    labels === undefined || labels.has(label) ? '' : whole,
  );
}

export function commentMarkPattern(): RegExp {
  return new RegExp(MARK_RE.source, 'g');
}

export function newCommentLabel(
  taken: ReadonlySet<string>,
  random: () => number = Math.random,
): string {
  for (let length = 4; ; length += 1) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      let suffix = '';
      while (suffix.length < length) suffix += Math.floor(random() * 16).toString(16);
      const label = `${COMMENT_LABEL_PREFIX}${suffix}`;
      if (!taken.has(label)) return label;
    }
  }
}

export function labelFromLegacyId(id: string, taken: ReadonlySet<string>): string {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.codePointAt(0) as number;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, '0');
  for (let length = 4; length <= hex.length; length += 1) {
    const label = `${COMMENT_LABEL_PREFIX}${hex.slice(0, length)}`;
    if (!taken.has(label)) return label;
  }
  return newCommentLabel(taken);
}
