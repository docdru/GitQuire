import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILES = 5000;
const MAX_DEPTH = 12;
const MAX_DIRECTORIES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SCAN_REUSE_MS = 5000;
const DOC_EXTENSIONS = ['.mdx', '.md'] as const;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'venv',
  'env',
  '__pycache__',
  'vendor',
  'dist',
  'build',
  'out',
  'output',
  'coverage',
]);

export function docNameForPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  const extension = DOC_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  return extension === undefined ? undefined : path.slice(0, -extension.length);
}

export interface ScanFilter {
  isExcluded(relativePath: string): boolean;
  isDirExcluded(relativePath: string): boolean;
}

function markdownFiles(root: string, filter: ScanFilter | undefined): string[] {
  const files: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && files.length < MAX_FILES && visited < MAX_DIRECTORIES) {
    const next = queue.shift();
    if (next === undefined) break;
    visited += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, next.dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = next.dir === '' ? entry.name : `${next.dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (next.depth >= MAX_DEPTH || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (filter?.isDirExcluded(relative) === true) continue;
        queue.push({ dir: relative, depth: next.depth + 1 });
      } else if (entry.isFile() && docNameForPath(entry.name) !== undefined) {
        if (filter?.isExcluded(relative) === true) continue;
        files.push(relative);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

export interface ScannedPage<T> {
  path: string;
  modifiedMs: number;
  value: T;
}

export interface PageScan<T> {
  all: () => ScannedPage<T>[];
}

interface CachedPage<T> {
  modifiedMs: number;
  size: number;
  page: ScannedPage<T> | undefined;
}

export function createPageScan<T>(
  root: string,
  extract: (path: string, markdown: string) => T,
  now: () => number = Date.now,
  filter: () => ScanFilter | undefined = () => undefined,
): PageScan<T> {
  const cache = new Map<string, CachedPage<T>>();
  let lastScan: { at: number; pages: ScannedPage<T>[] } | undefined;

  function read(path: string): ScannedPage<T> | undefined {
    const full = join(root, path);
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(full);
    } catch {
      cache.delete(path);
      return undefined;
    }
    const cached = cache.get(path);
    if (cached !== undefined && cached.modifiedMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.page;
    }
    let page: ScannedPage<T> | undefined;
    if (stat.size <= MAX_FILE_BYTES) {
      try {
        const value = extract(path, readFileSync(full, 'utf8'));
        page = { path, modifiedMs: stat.mtimeMs, value };
      } catch {
        page = undefined;
      }
    }
    cache.set(path, { modifiedMs: stat.mtimeMs, size: stat.size, page });
    return page;
  }

  function all(): ScannedPage<T>[] {
    const at = now();
    if (lastScan !== undefined && at - lastScan.at < SCAN_REUSE_MS && at >= lastScan.at) {
      return lastScan.pages;
    }
    const paths = markdownFiles(root, filter());
    const live = new Set(paths);
    for (const path of cache.keys()) {
      if (!live.has(path)) cache.delete(path);
    }
    const pages: ScannedPage<T>[] = [];
    for (const path of paths) {
      const page = read(path);
      if (page !== undefined) pages.push(page);
    }
    lastScan = { at, pages };
    return pages;
  }

  return { all };
}
