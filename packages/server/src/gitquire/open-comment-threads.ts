import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CommentAuthor,
  type CommentThread,
  readCommentThreads,
} from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import { docNameForPath } from './page-scan.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCANNED_FILES = 5000;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', 'vendor']);

export interface OpenCommentSummary {
  threadId: string;
  author: string;
  body: string;
  quote: string;
  replies: number;
}

function authorLabel(author: CommentAuthor): string {
  if (author.login !== undefined && author.login !== '') return `@${author.login}`;
  if (author.name !== undefined && author.name !== '') return author.name;
  return author.id;
}

function summarize(thread: CommentThread): OpenCommentSummary | undefined {
  const first = thread.comments[0];
  if (first === undefined) return undefined;
  return {
    threadId: thread.id,
    author: authorLabel(first.author),
    body: first.body,
    quote: thread.anchor.exact,
    replies: thread.comments.length - 1,
  };
}

export function openCommentThreads(markdown: string): OpenCommentSummary[] {
  const summaries: OpenCommentSummary[] = [];
  for (const thread of readCommentThreads(markdown)) {
    if (thread.resolved) continue;
    const summary = summarize(thread);
    if (summary !== undefined) summaries.push(summary);
  }
  return summaries;
}

async function readMarkdown(absPath: string): Promise<string | null> {
  try {
    const info = await stat(absPath);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

export async function readOpenCommentThreads(absPath: string): Promise<OpenCommentSummary[] | null> {
  const markdown = await readMarkdown(absPath);
  return markdown === null ? null : openCommentThreads(markdown);
}

export async function countOpenCommentThreads(
  projectDir: string,
  relPaths: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await Promise.all(
    [...new Set(relPaths)].map(async (relPath) => {
      if (docNameForPath(relPath) === undefined) return;
      const markdown = await readMarkdown(join(projectDir, relPath));
      if (markdown === null) return;
      const open = openCommentThreads(markdown).length;
      if (open > 0) counts.set(relPath, open);
    }),
  );
  return counts;
}

async function markdownFilesUnder(projectDir: string, relDir: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [relDir === '.' ? '' : relDir.replace(/\/+$/, '')];
  while (queue.length > 0 && files.length < MAX_SCANNED_FILES) {
    const dir = queue.shift() ?? '';
    let entries: Dirent[];
    try {
      entries = await readdir(join(projectDir, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(relative);
      } else if (entry.isFile() && docNameForPath(entry.name) !== undefined) {
        files.push(relative);
        if (files.length >= MAX_SCANNED_FILES) break;
      }
    }
  }
  return files;
}

export async function countOpenCommentThreadsUnder(
  projectDir: string,
  relDir: string,
): Promise<Map<string, number>> {
  const files = await markdownFilesUnder(projectDir, relDir);
  const byPath = await countOpenCommentThreads(projectDir, files);
  const byDocName = new Map<string, number>();
  for (const [relPath, count] of byPath) {
    byDocName.set(docNameForPath(relPath) ?? relPath, count);
  }
  return byDocName;
}
