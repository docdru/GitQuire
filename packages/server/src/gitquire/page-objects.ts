import { parseFrontmatterRecord, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { splitCommentTrailer } from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import { docNameForPath, type ScannedPage } from './page-scan.ts';

const MAX_KEYS = 50;
const MAX_LIST_ITEMS = 50;
const MAX_TEXT_CHARS = 300;
const MAX_DEPTH = 3;
const MAX_TASKS_PER_PAGE = 100;
const MAX_DECISIONS = 10;
const MAX_LINE_CHARS = 1000;
const MAX_FIELD_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CIRCULAR = '[circular]';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type FieldValue =
  | string
  | number
  | boolean
  | null
  | FieldValue[]
  | { [key: string]: FieldValue };

export interface PageTask {
  id: string;
  text: string;
  done: boolean;
  line: number;
  mentions: string[];
  source: string;
  offset?: number;
  due?: string;
}

export interface PageFacts {
  docName: string;
  title: string;
  fields: Record<string, FieldValue>;
  tasks: PageTask[];
  decisions: string[];
  clipped: boolean;
}

export interface PageObject extends PageFacts {
  path: string;
  modified: string;
}

const ANY_HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/;
const DECISIONS_HEADING_RE = /^decisions?$/i;
const LIST_ITEM_RE = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(\S.*)$/;
const DECISION_LINE_RE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?\**decision\**:\**[ \t]*(\S.*)$/i;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TASK_RE = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t]+(\S.*)$/;
const DUE_RE = /(?:\u{1F4C5}\uFE0F?|(?<![\w-])due:?)[ \t]*(\d{4}-\d{2}-\d{2})(?!\d)/iu;
const MENTION_RE = /(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\w-])/g;

function clipText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const kept = Array.from(text.slice(0, MAX_TEXT_CHARS * 2)).slice(0, MAX_TEXT_CHARS - 1);
  return `${kept.join('')}…`;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return CIRCULAR;
  }
}

function dateText(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

function fieldValueWithin(value: unknown, depth: number, parents: readonly object[]): FieldValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clipText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return dateText(value);
  if (typeof value !== 'object') return clipText(String(value));
  if (parents.includes(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return clipText(compactJson(value));
  const inside = [...parents, value];
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LIST_ITEMS).map((item) => fieldValueWithin(item, depth + 1, inside));
  }
  const record: { [key: string]: FieldValue } = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    if (!UNSAFE_KEYS.has(key)) record[key] = fieldValueWithin(item, depth + 1, inside);
  }
  return record;
}

export function fieldValue(value: unknown): FieldValue {
  return fieldValueWithin(value, 0, []);
}

interface ReadFields {
  fields: Record<string, FieldValue>;
  clipped: boolean;
}

function fieldsOf(markdown: string): ReadFields {
  const record = parseFrontmatterRecord(markdown);
  const fields: Record<string, FieldValue> = {};
  if (record === null) return { fields, clipped: false };
  let clipped = Object.keys(record).length > MAX_KEYS;
  let bytes = 0;
  for (const [key, value] of Object.entries(record).slice(0, MAX_KEYS)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const field = fieldValue(value);
    bytes += key.length + compactJson(field).length;
    if (bytes > MAX_FIELD_BYTES) {
      clipped = true;
      break;
    }
    fields[key] = field;
  }
  return { fields, clipped };
}

function mentionsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    seen.add((match[1] as string).toLowerCase());
  }
  return [...seen];
}

const CHECKBOX_RE = /^([ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\])/;

function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) count += 1;
  return count;
}

function lineIsAmbiguous(markdown: string, source: string): boolean {
  const flipped = source.replace(
    CHECKBOX_RE,
    (_match: string, open: string, mark: string, close: string) =>
      `${open}${mark === ' ' ? 'x' : ' '}${close}`,
  );
  const forms = new Set([source, flipped, source.replace(CHECKBOX_RE, '$1X$3')]);
  let count = 0;
  for (const form of forms) count += occurrences(markdown, form);
  return count > 1;
}

function dueDate(text: string): string | undefined {
  const match = DUE_RE.exec(text);
  if (match === null) return undefined;
  const day = match[1] as string;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(day) ? day : undefined;
}

function taskId(text: string, ordinal: number): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(index)) >>> 0;
  }
  return `${hash.toString(36)}-${ordinal}`;
}

export function headingText(line: string): string | undefined {
  if (!line.startsWith('# ') && !line.startsWith('#\t')) return undefined;
  let text = line.slice(1).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end === 0) return undefined;
  const before = text[end - 1];
  if (end < text.length && (before === ' ' || before === '\t')) text = text.slice(0, end).trimEnd();
  return text === '' ? undefined : text;
}

interface BodyFacts {
  heading: string | undefined;
  tasks: PageTask[];
  decisions: string[];
  clipped: boolean;
}

function decisionIn(line: string, inDecisions: boolean): string | undefined {
  const labelled = DECISION_LINE_RE.exec(line);
  if (labelled !== null) return clipText((labelled[1] as string).trim());
  if (!inDecisions) return undefined;
  const item = LIST_ITEM_RE.exec(line);
  return item === null ? undefined : clipText((item[1] as string).trim());
}

function isClosingFence(marker: string, rest: string, open: string): boolean {
  return marker[0] === open[0] && marker.length >= open.length && rest.trim() === '';
}

function readBody(body: string, firstLine: number, bodyStart: number): BodyFacts {
  const tasks: PageTask[] = [];
  const decisions: string[] = [];
  let inDecisions = false;
  const seen = new Map<string, number>();
  let heading: string | undefined;
  let fence: string | undefined;
  let inComment = false;
  let clipped = false;
  const lines = body.split('\n');
  let next = bodyStart;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const start = next;
    next += raw.length + 1;
    const line = raw.replace(/\r$/, '');
    if (line.length > MAX_LINE_CHARS) continue;
    if (inComment) {
      inComment = !line.includes('-->');
      continue;
    }
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] as string;
      if (fence === undefined) {
        fence = marker;
      } else if (isClosingFence(marker, fenceMatch[2] ?? '', fence)) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;
    if (line.trimStart().startsWith('<!--')) {
      inComment = !line.includes('-->');
      continue;
    }
    heading ??= headingText(line);
    const section = ANY_HEADING_RE.exec(line);
    if (section !== null) {
      inDecisions = DECISIONS_HEADING_RE.test((section[1] as string).trim());
      continue;
    }
    const decision = decisionIn(line, inDecisions);
    if (decision !== undefined && decisions.length < MAX_DECISIONS) decisions.push(decision);
    const task = TASK_RE.exec(line);
    if (task === null) continue;
    if (tasks.length >= MAX_TASKS_PER_PAGE) {
      clipped = true;
      continue;
    }
    const text = clipText((task[2] as string).trim());
    const ordinal = seen.get(text) ?? 0;
    seen.set(text, ordinal + 1);
    const due = dueDate(text);
    tasks.push({
      id: taskId(text, ordinal),
      text,
      done: task[1] !== ' ',
      line: firstLine + index,
      mentions: mentionsIn(text),
      source: line,
      offset: start,
      ...(due === undefined ? {} : { due }),
    });
  }
  return { heading, tasks, decisions, clipped };
}

function titleOf(fields: Record<string, FieldValue>, heading: string | undefined): string {
  const given = Object.hasOwn(fields, 'title') ? fields.title : undefined;
  if (typeof given === 'number') return String(given);
  if (typeof given === 'string' && given.trim() !== '') return given.trim();
  return heading ?? '';
}

export function pageFacts(path: string, source: string): PageFacts {
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const markdown = source.slice(bom);
  const docName = docNameForPath(path) ?? path;
  const stripped = stripFrontmatter(markdown);
  const prefix = markdown.slice(0, markdown.length - stripped.body.length);
  const firstLine = prefix.split('\n').length;
  const read = fieldsOf(markdown);
  const body = readBody(splitCommentTrailer(stripped.body).body, firstLine, prefix.length);
  const tasks = body.tasks.map(({ offset, ...task }) =>
    lineIsAmbiguous(markdown, task.source) && offset !== undefined
      ? { ...task, offset: offset + bom }
      : task,
  );
  const title = titleOf(read.fields, body.heading) || docName.slice(docName.lastIndexOf('/') + 1);
  return {
    docName,
    title: clipText(title),
    fields: read.fields,
    tasks,
    decisions: body.decisions,
    clipped: read.clipped || body.clipped,
  };
}

export function pageObject(page: ScannedPage<PageFacts>): PageObject {
  return {
    ...page.value,
    path: page.path,
    modified: new Date(page.modifiedMs).toISOString(),
  };
}

export const MAX_LISTED_OBJECTS = 2000;

export interface ObjectList {
  pages: PageObject[];
  truncated: boolean;
}

export function listObjects(
  pages: readonly ScannedPage<PageFacts>[],
  maxBytes: number = MAX_RESPONSE_BYTES,
): ObjectList {
  const listed: PageObject[] = [];
  let bytes = 0;
  let truncated = false;
  for (const page of pages) {
    if (Object.keys(page.value.fields).length === 0 && page.value.tasks.length === 0) continue;
    const next = pageObject(page);
    bytes += compactJson(next).length;
    if (listed.length >= MAX_LISTED_OBJECTS || bytes > maxBytes) {
      truncated = true;
      break;
    }
    listed.push(next);
  }
  return { pages: listed, truncated };
}

export interface ObjectListCache {
  body: (pages: readonly ScannedPage<PageFacts>[]) => string;
}

export function createObjectListCache(): ObjectListCache {
  let last: { pages: readonly ScannedPage<PageFacts>[]; body: string } | undefined;
  return {
    body: (pages) => {
      if (last === undefined || last.pages !== pages) {
        last = { pages, body: JSON.stringify(listObjects(pages)) };
      }
      return last.body;
    },
  };
}
