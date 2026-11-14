import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathspecArgs } from '@inkeep/open-knowledge-core';
import type { RunGit } from '../repo-bootstrap.ts';
import { type ChangedPage, isPagePath, parseNameStatus } from './model.ts';

export interface GitIdentity {
  name: string;
  email: string;
}

type Env = Readonly<Record<string, string>>;

function identityArgs(who: GitIdentity | undefined): string[] {
  return who === undefined ? [] : ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`];
}

function tryGit(
  runGit: RunGit,
  args: readonly string[],
  cwd: string,
  env?: Env,
): string | undefined {
  try {
    return runGit(args, cwd, env);
  } catch {
    return undefined;
  }
}

export function headSha(runGit: RunGit, dir: string, ref = 'HEAD'): string {
  return runGit(['rev-parse', '--verify', `${ref}^{commit}`], dir).trim();
}

export function changedPages(runGit: RunGit, dir: string, baseSha: string): ChangedPage[] {
  const tracked = parseNameStatus(runGit(['diff', '--name-status', '--no-renames', baseSha], dir));
  const untracked = runGit(['ls-files', '--others', '--exclude-standard'], dir)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((path): ChangedPage => ({ path, change: 'added' }));
  const seen = new Set<string>();
  const pages: ChangedPage[] = [];
  for (const page of [...tracked, ...untracked]) {
    if (!isPagePath(page.path) || seen.has(page.path)) continue;
    seen.add(page.path);
    pages.push(page);
  }
  return pages.sort((a, b) => a.path.localeCompare(b.path));
}

export function fileAt(runGit: RunGit, dir: string, ref: string, path: string): string | null {
  const out = tryGit(runGit, ['show', `${ref}:${path}`], dir);
  return out === undefined ? null : out;
}

export function workingFile(dir: string, path: string): string | null {
  const full = join(dir, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

export function commitPending(
  runGit: RunGit,
  dir: string,
  message: string,
  who?: GitIdentity,
): boolean {
  const status = runGit(['status', '--porcelain', '--untracked-files=all', '--no-renames'], dir);
  const paths = status
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
    .filter((path) => isPagePath(path));
  if (paths.length === 0) return false;
  runGit(['add', '-A', ...pathspecArgs(paths)], dir);
  if (tryGit(runGit, ['diff', '--cached', '--quiet'], dir) !== undefined) return false;
  runGit([...identityArgs(who), 'commit', '--quiet', '-m', message], dir);
  return true;
}

export function pushBranch(runGit: RunGit, dir: string, branch: string, env: Env): void {
  runGit(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], dir, env);
}

export function fetchBranch(runGit: RunGit, dir: string, branch: string, env: Env): string {
  runGit(
    [
      'fetch',
      '--quiet',
      '--no-tags',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    dir,
    env,
  );
  return headSha(runGit, dir, `refs/remotes/origin/${branch}`);
}

export interface ConflictChunk {
  kind: 'same' | 'conflict';
  text?: string;
  live?: string;
  draft?: string;
  base?: string;
}

export interface FileConflict {
  path: string;
  chunks: ConflictChunk[];
}

export function parseDiff3(merged: string): ConflictChunk[] {
  const chunks: ConflictChunk[] = [];
  const lines = merged.split(/(?<=\n)/);
  let same = '';
  let mode: 'none' | 'ours' | 'base' | 'theirs' = 'none';
  let ours = '';
  let base = '';
  let theirs = '';
  for (const line of lines) {
    if (mode === 'none' && line.startsWith('<<<<<<< ')) {
      if (same !== '') chunks.push({ kind: 'same', text: same });
      same = '';
      mode = 'ours';
      ours = '';
      base = '';
      theirs = '';
      continue;
    }
    if (mode === 'ours' && line.startsWith('||||||| ')) {
      mode = 'base';
      continue;
    }
    if ((mode === 'ours' || mode === 'base') && line.startsWith('=======')) {
      mode = 'theirs';
      continue;
    }
    if (mode === 'theirs' && line.startsWith('>>>>>>> ')) {
      chunks.push({ kind: 'conflict', draft: ours, base, live: theirs });
      mode = 'none';
      continue;
    }
    if (mode === 'none') same += line;
    else if (mode === 'ours') ours += line;
    else if (mode === 'base') base += line;
    else theirs += line;
  }
  if (same !== '') chunks.push({ kind: 'same', text: same });
  return chunks;
}

function unmergedPaths(runGit: RunGit, dir: string): string[] {
  return runGit(['diff', '--name-only', '--diff-filter=U'], dir)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function stage(runGit: RunGit, dir: string, n: 1 | 2 | 3, path: string): string {
  return tryGit(runGit, ['show', `:${n}:${path}`], dir) ?? '';
}

function conflictOf(runGit: RunGit, dir: string, path: string): FileConflict {
  const scratch = join(dir, '.git', 'gitquire-merge');
  const ours = `${scratch}-ours`;
  const base = `${scratch}-base`;
  const theirs = `${scratch}-theirs`;
  writeFileSync(ours, stage(runGit, dir, 2, path));
  writeFileSync(base, stage(runGit, dir, 1, path));
  writeFileSync(theirs, stage(runGit, dir, 3, path));
  let merged: string;
  try {
    merged = runGit(
      [
        'merge-file',
        '-p',
        '--diff3',
        '-L',
        'draft',
        '-L',
        'base',
        '-L',
        'live',
        ours,
        base,
        theirs,
      ],
      dir,
    );
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    merged = typeof stdout === 'string' ? stdout : '';
  }
  return { path, chunks: parseDiff3(merged) };
}

export type MergeOutcome =
  | { kind: 'up-to-date' }
  | { kind: 'merged' }
  | { kind: 'conflicts'; files: FileConflict[] };

export function mergeBase(
  runGit: RunGit,
  dir: string,
  base: string,
  who: GitIdentity,
  resolved?: Readonly<Record<string, string>>,
): MergeOutcome {
  const target = `refs/remotes/origin/${base}`;
  if (tryGit(runGit, ['merge-base', '--is-ancestor', target, 'HEAD'], dir) !== undefined) {
    return { kind: 'up-to-date' };
  }
  const merged = tryGit(
    runGit,
    [...identityArgs(who), 'merge', '--no-ff', '-m', 'Update the draft with the live wiki', target],
    dir,
  );
  if (merged !== undefined) return { kind: 'merged' };
  const paths = unmergedPaths(runGit, dir);
  if (paths.length === 0) {
    tryGit(runGit, ['merge', '--abort'], dir);
    throw new Error('Updating the draft failed.');
  }
  if (resolved !== undefined && paths.every((path) => resolved[path] !== undefined)) {
    for (const path of paths) {
      writeFileSync(join(dir, path), resolved[path] as string);
      runGit(['add', ...pathspecArgs([path])], dir);
    }
    runGit([...identityArgs(who), 'commit', '--no-edit', '--quiet'], dir);
    return { kind: 'merged' };
  }
  const files = paths.map((path) => conflictOf(runGit, dir, path));
  runGit(['merge', '--abort'], dir);
  return { kind: 'conflicts', files };
}

export interface CommitInfo {
  sha: string;
  email: string;
  at: number;
}

export function commitsTouching(runGit: RunGit, dir: string, path: string, max = 50): CommitInfo[] {
  return runGit(['log', `-n${max}`, '--format=%H%x1f%ae%x1f%ct', ...pathspecArgs([path])], dir)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [sha = '', email = '', at = '0'] = line.split('\x1f');
      return { sha, email: email.toLowerCase(), at: Number(at) * 1000 };
    });
}
