import { stripFrontmatter } from '@gitquire/core';
import { pageTextWithoutComments } from '@gitquire/core/gitquire/comment-threads';
import { docNameForPath, type ScannedPage } from './page-scan.ts';

const MAX_PER_PAGE = 200;
const MAX_LISTED = 2000;
const MAX_LINE_CHARS = 2000;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 80;

const MENTION_RE = /(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\w-])/g;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TASK_RE = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]+/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;
const LEAD_RE = /^[ \t>]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+)?/;

export interface PageMention {
  id: string;
  path: string;
  docName: string;
  login: string;
  heading: string;
  snippet: string;
  occurrence: number;
  line: number;
}

export interface PageMentions {
  mentions: PageMention[];
  clipped: boolean;
}

function blank(text: string): string {
  return ' '.repeat(text.length);
}

function blankInlineCode(line: string): string {
  let out = '';
  let at = 0;
  while (at < line.length) {
    const tick = line.indexOf('`', at);
    if (tick === -1) {
      out += line.slice(at);
      break;
    }
    let run = tick;
    while (line[run] === '`') run += 1;
    const marker = line.slice(tick, run);
    const close = line.indexOf(marker, run);
    if (close === -1) {
      out += line.slice(at);
      break;
    }
    out += line.slice(at, tick) + blank(line.slice(tick, close + marker.length));
    at = close + marker.length;
  }
  return out;
}

function blankNonText(line: string): string {
  return blankInlineCode(line)
    .replace(/<!--.*?-->/g, blank)
    .replace(/\]\([^)]*\)/g, blank)
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, blank);
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<!--.*?-->/g, '')
    .replace(/\[\^[^\]]*\]/g, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ');
}

function snippetOf(line: string, at: number, length: number): string {
  const lead = LEAD_RE.exec(line)?.[0].length ?? 0;
  const before = plainText(line.slice(lead, at)).trimStart();
  const after = plainText(line.slice(at + length)).trimEnd();
  const head = before.length > SNIPPET_BEFORE ? `…${before.slice(-SNIPPET_BEFORE)}` : before;
  const tail = after.length > SNIPPET_AFTER ? `${after.slice(0, SNIPPET_AFTER)}…` : after;
  return `${head}${line.slice(at, at + length)}${tail}`;
}

function isClosingFence(marker: string, rest: string, open: string): boolean {
  return marker[0] === open[0] && marker.length >= open.length && rest.trim() === '';
}

export function pageMentionsIn(path: string, source: string): PageMentions {
  const markdown = source.startsWith('﻿') ? source.slice(1) : source;
  const docName = docNameForPath(path) ?? path;
  const stripped = stripFrontmatter(markdown);
  const firstLine = markdown.slice(0, markdown.length - stripped.body.length).split('\n').length;
  const lines = pageTextWithoutComments(stripped.body).split('\n');
  const mentions: PageMention[] = [];
  const counts = new Map<string, number>();
  let heading = '';
  let fence: string | undefined;
  let inHtmlComment = false;
  let previousBlank = true;
  let clipped = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).replace(/\r$/, '');
    const wasBlank = previousBlank;
    previousBlank = line.trim() === '';
    if (inHtmlComment) {
      inHtmlComment = !line.includes('-->');
      continue;
    }
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] as string;
      if (fence === undefined) fence = marker;
      else if (isClosingFence(marker, fenceMatch[2] ?? '', fence)) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (wasBlank && INDENTED_CODE_RE.test(line)) {
      previousBlank = true;
      continue;
    }
    if (line.trimStart().startsWith('<!--') && !line.includes('-->')) {
      inHtmlComment = true;
      continue;
    }
    const section = HEADING_RE.exec(line);
    if (section !== null) heading = (section[2] as string).trim();
    if (line.length > MAX_LINE_CHARS || TASK_RE.test(line) || !line.includes('@')) continue;
    const text = blankNonText(line);
    for (const match of text.matchAll(MENTION_RE)) {
      if (mentions.length >= MAX_PER_PAGE) {
        clipped = true;
        break;
      }
      const login = (match[1] as string).toLowerCase();
      const occurrence = counts.get(login) ?? 0;
      counts.set(login, occurrence + 1);
      mentions.push({
        id: `page:${docName}:${login}:${occurrence}`,
        path,
        docName,
        login,
        heading,
        snippet: snippetOf(line, match.index ?? 0, match[0].length),
        occurrence,
        line: firstLine + index,
      });
    }
  }
  return { mentions, clipped };
}

export interface PageMentionList {
  mentions: PageMention[];
  truncated: boolean;
}

export function listPageMentions(
  pages: readonly ScannedPage<PageMentions>[],
  login?: string,
): PageMentionList {
  const wanted = login?.toLowerCase();
  const listed: PageMention[] = [];
  let truncated = false;
  const sorted = [...pages].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const page of sorted) {
    if (page.value.clipped) truncated = true;
    for (const mention of page.value.mentions) {
      if (wanted !== undefined && mention.login !== wanted) continue;
      if (listed.length >= MAX_LISTED) return { mentions: listed, truncated: true };
      listed.push(mention);
    }
  }
  return { mentions: listed, truncated };
}
