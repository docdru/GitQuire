import { stripFrontmatter } from '../extensions/frontmatter.ts';
import { parseWikiLink } from '../extensions/wiki-link.ts';
import { parseFrontmatterRecord } from '../frontmatter/record.ts';
import { classifyWikiLinkTarget } from '../utils/link-targets.ts';
import { splitCommentTrailer } from './comment-threads.ts';

export type RelationOrigin = 'frontmatter' | 'inline';

export interface RelationLink {
  relation: string;
  target: string;
  anchor: string | null;
  origin: RelationOrigin;
  line: number;
}

export interface InlineRelationField {
  relation: string;
  value: string;
  valueStart: number;
}

const MAX_RELATION_CHARS = 60;
const MAX_LINKS_PER_PAGE = 500;
const MAX_FRONTMATTER_DEPTH = 3;
const RELATION_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _\-./]*$/u;
const LINE_FIELD_RE =
  /^([ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?)([^[\]()`:\s][^[\]()`:]*?)::(?!:)[ \t]*(.*)$/;
const BRACKET_FIELD_RE = /[[(]([^[\]()`:\s][^[\]()`:]*?)::(?!:)[ \t]*/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export function normalizeRelation(name: string): string | undefined {
  const unwrapped = name
    .trim()
    .replace(/^(\*\*|__)(.*)\1$/, '$2')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (unwrapped === '' || unwrapped.length > MAX_RELATION_CHARS) return undefined;
  return RELATION_NAME_RE.test(unwrapped) ? unwrapped : undefined;
}

function closingIndex(line: string, from: number, opener: '[' | '('): number {
  let index = from;
  while (index < line.length) {
    if (line.startsWith('[[', index)) {
      const end = line.indexOf(']]', index + 2);
      if (end === -1) return -1;
      index = end + 2;
      continue;
    }
    const char = line[index];
    if (char === '`') {
      const end = line.indexOf('`', index + 1);
      if (end === -1) return -1;
      index = end + 1;
      continue;
    }
    if ((opener === '[' && char === ']') || (opener === '(' && char === ')')) return index;
    if (char === '[' || char === '(') {
      const nested = closingIndex(line, index + 1, char);
      if (nested === -1) return -1;
      index = nested + 1;
      continue;
    }
    index += 1;
  }
  return -1;
}

export function inlineRelationFields(line: string): InlineRelationField[] {
  const lineField = LINE_FIELD_RE.exec(line);
  if (lineField !== null) {
    const relation = normalizeRelation(lineField[2] ?? '');
    if (relation !== undefined) {
      const value = lineField[3] ?? '';
      return [{ relation, value, valueStart: line.length - value.length }];
    }
  }
  const fields: InlineRelationField[] = [];
  BRACKET_FIELD_RE.lastIndex = 0;
  for (let match = BRACKET_FIELD_RE.exec(line); match !== null; ) {
    const opener = line[match.index] === '(' ? '(' : '[';
    const valueStart = match.index + match[0].length;
    const close = closingIndex(line, valueStart, opener);
    const relation = normalizeRelation(match[1] ?? '');
    if (close !== -1 && relation !== undefined) {
      fields.push({ relation, value: line.slice(valueStart, close), valueStart });
      BRACKET_FIELD_RE.lastIndex = close + 1;
    }
    match = BRACKET_FIELD_RE.exec(line);
  }
  return fields;
}

interface LinkTarget {
  target: string;
  anchor: string | null;
}

function wikiLinksIn(text: string): LinkTarget[] {
  const links: LinkTarget[] = [];
  let index = text.indexOf('[[');
  while (index !== -1) {
    const embedded = index > 0 && text[index - 1] === '!';
    const parsed = parseWikiLink(text.slice(index));
    if (parsed === null) {
      index = text.indexOf('[[', index + 2);
      continue;
    }
    const classified = classifyWikiLinkTarget(parsed.target, parsed.anchor);
    if (!embedded && classified?.kind === 'doc') {
      links.push({ target: classified.docName, anchor: classified.anchor });
    }
    index = text.indexOf('[[', index + parsed.raw.length);
  }
  return links;
}

function linksInFrontmatterValue(value: unknown, depth: number): LinkTarget[] {
  if (typeof value === 'string') return wikiLinksIn(value);
  if (!Array.isArray(value) || depth > MAX_FRONTMATTER_DEPTH) return [];
  if (value.length === 1 && Array.isArray(value[0]) && value[0].length === 1) {
    const inner = value[0][0];
    if (typeof inner === 'string' && !inner.includes('[[')) return wikiLinksIn(`[[${inner}]]`);
  }
  return value.flatMap((item) => linksInFrontmatterValue(item, depth + 1));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function frontmatterKeyLine(frontmatter: string, key: string): number {
  const keyRe = new RegExp(`^["']?${escapeRegExp(key)}["']?[ \\t]*:`);
  const lines = frontmatter.split(/\r?\n/);
  const found = lines.findIndex((line) => keyRe.test(line));
  return found === -1 ? 0 : found;
}

export function frontmatterRelationLinks(markdown: string): RelationLink[] {
  const record = parseFrontmatterRecord(markdown);
  if (record === null) return [];
  const { frontmatter } = stripFrontmatter(markdown);
  const links: RelationLink[] = [];
  for (const [key, value] of Object.entries(record)) {
    const relation = normalizeRelation(key);
    if (relation === undefined) continue;
    const targets = linksInFrontmatterValue(value, 0);
    if (targets.length === 0) continue;
    const line = frontmatterKeyLine(frontmatter, key);
    for (const target of targets) links.push({ relation, ...target, origin: 'frontmatter', line });
  }
  return links;
}

export function inlineRelationLinks(markdown: string): RelationLink[] {
  const { frontmatter, body } = stripFrontmatter(markdown);
  const lineOffset = frontmatter === '' ? 0 : frontmatter.split(/\r?\n/).length - 1;
  const lines = splitCommentTrailer(body).body.split(/\r?\n/);
  const links: RelationLink[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== undefined) {
      const closing = fenceMatch?.[1];
      if (closing !== undefined && closing[0] === fence.char && closing.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    const opening = fenceMatch?.[1];
    if (opening !== undefined) {
      fence = { char: opening[0] ?? '`', length: opening.length };
      continue;
    }
    if (!line.includes('::')) continue;
    for (const field of inlineRelationFields(line)) {
      for (const target of wikiLinksIn(field.value)) {
        links.push({
          relation: field.relation,
          ...target,
          origin: 'inline',
          line: lineOffset + index,
        });
      }
    }
  }
  return links;
}

export function relationLinks(markdown: string): RelationLink[] {
  const seen = new Set<string>();
  const links: RelationLink[] = [];
  for (const link of [...frontmatterRelationLinks(markdown), ...inlineRelationLinks(markdown)]) {
    const key = JSON.stringify([link.relation, link.target, link.anchor, link.origin]);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
    if (links.length >= MAX_LINKS_PER_PAGE) break;
  }
  return links;
}
