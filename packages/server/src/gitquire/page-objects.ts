import { parseFrontmatterRecord, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { COMMENT_TRAILER_OPEN } from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import { docNameForPath, type ScannedPage } from './page-scan.ts';

const MAX_KEYS = 50;
const MAX_LIST_ITEMS = 50;
const MAX_TEXT_CHARS = 500;
const MAX_DEPTH = 3;
const MAX_TASKS_PER_PAGE = 200;

export type FieldValue =
  | string
  | number
  | boolean
  | null
  | FieldValue[]
  | { [key: string]: FieldValue };

export interface PageTask {
  text: string;
  done: boolean;
  line: number;
  mentions: string[];
}

export interface PageFacts {
  docName: string;
  title: string;
  fields: Record<string, FieldValue>;
  tasks: PageTask[];
}

export interface PageObject extends PageFacts {
  path: string;
  modified: string;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const TASK_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s+(\S.*)$/;
const HEADING_RE = /^#\s+(\S.*?)\s*#*\s*$/;
const MENTION_RE = /(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\w-])/g;

function clipText(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS - 1)}…`;
}

function dateText(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

export function fieldValue(value: unknown, depth = 0): FieldValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clipText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return dateText(value);
  if (depth >= MAX_DEPTH) return clipText(JSON.stringify(value) ?? '');
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LIST_ITEMS).map((item) => fieldValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const record: { [key: string]: FieldValue } = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
      record[key] = fieldValue(item, depth + 1);
    }
    return record;
  }
  return clipText(String(value));
}

function fieldsOf(markdown: string): Record<string, FieldValue> {
  const record = parseFrontmatterRecord(markdown);
  const fields: Record<string, FieldValue> = {};
  if (record === null) return fields;
  for (const [key, value] of Object.entries(record).slice(0, MAX_KEYS)) {
    fields[key] = fieldValue(value);
  }
  return fields;
}

function mentionsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    seen.add((match[1] as string).toLowerCase());
  }
  return [...seen];
}

interface BodyFacts {
  heading: string | undefined;
  tasks: PageTask[];
}

function readBody(body: string, firstLine: number): BodyFacts {
  const tasks: PageTask[] = [];
  let heading: string | undefined;
  let fence: string | undefined;
  const lines = body.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).replace(/\r$/, '');
    if (line.startsWith(COMMENT_TRAILER_OPEN)) break;
    const marker = FENCE_RE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;
    heading ??= HEADING_RE.exec(line)?.[1];
    const task = TASK_RE.exec(line);
    if (task === null || tasks.length >= MAX_TASKS_PER_PAGE) continue;
    const text = clipText((task[2] as string).trim());
    tasks.push({
      text,
      done: task[1] !== ' ',
      line: firstLine + index,
      mentions: mentionsIn(text),
    });
  }
  return { heading, tasks };
}

export function pageFacts(path: string, markdown: string): PageFacts {
  const docName = docNameForPath(path) ?? path;
  const { body } = stripFrontmatter(markdown);
  const prefix = markdown.slice(0, markdown.length - body.length);
  const firstLine = prefix.split('\n').length;
  const fields = fieldsOf(markdown);
  const { heading, tasks } = readBody(body, firstLine);
  const given = typeof fields.title === 'string' ? fields.title.trim() : '';
  const title = given !== '' ? given : (heading ?? docName.slice(docName.lastIndexOf('/') + 1));
  return { docName, title: clipText(title), fields, tasks };
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

export function listObjects(pages: readonly ScannedPage<PageFacts>[]): ObjectList {
  const interesting = pages.filter(
    (page) => Object.keys(page.value.fields).length > 0 || page.value.tasks.length > 0,
  );
  return {
    pages: interesting.slice(0, MAX_LISTED_OBJECTS).map(pageObject),
    truncated: interesting.length > MAX_LISTED_OBJECTS,
  };
}
