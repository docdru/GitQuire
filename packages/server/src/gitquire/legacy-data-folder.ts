import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const LEGACY_DATA_DIR = '.ok';
const DATA_DIR = '.gitquire';

const SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', DATA_DIR]);
const MAX_DEPTH = 32;
const LEGACY_PATH_RE = /(^|[\\/!*])\.ok(?=$|[\\/\r])/g;

export interface LegacyDataFolderMigration {
  readonly moved: readonly { readonly from: string; readonly to: string }[];
  readonly kept: readonly string[];
  readonly rewrittenIgnoreFiles: readonly string[];
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function legacyFoldersUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (!isRealDirectory(path)) continue;
      if (name === LEGACY_DATA_DIR) {
        found.push(path);
        continue;
      }
      if (SKIPPED_DIRS.has(name) || name.startsWith('.gitquire-')) continue;
      walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function rewriteIgnoreFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const before = readFileSync(path, 'utf8');
  const after = before
    .split('\n')
    .map((line) =>
      line.trimStart().startsWith('#')
        ? line
        : line.replace(LEGACY_PATH_RE, (_match, lead: string) => `${lead}${DATA_DIR}`),
    )
    .join('\n');
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}

function repairMovedWorktrees(projectDir: string, dataDir: string): void {
  const worktrees = join(dataDir, 'worktrees');
  if (!isRealDirectory(worktrees) || !existsSync(join(projectDir, '.git'))) return;
  const paths = readdirSync(worktrees)
    .map((name) => join(worktrees, name))
    .filter((path) => existsSync(join(path, '.git')));
  if (paths.length === 0) return;
  try {
    execFileSync('git', ['worktree', 'repair', ...paths], {
      cwd: projectDir,
      stdio: 'ignore',
    });
  } catch {
    return;
  }
}

function moveEach(candidates: readonly string[]) {
  const moved: { from: string; to: string }[] = [];
  const kept: string[] = [];
  for (const from of candidates) {
    const to = join(dirname(from), DATA_DIR);
    if (existsSync(to)) {
      kept.push(from);
      continue;
    }
    renameSync(from, to);
    moved.push({ from, to });
  }
  return { moved, kept };
}

const LEGACY_HOME_DIRS: readonly (readonly [string, string])[] = [
  [LEGACY_DATA_DIR, DATA_DIR],
  ['.ok-beta', '.gitquire-beta'],
  ['.ok-dev', '.gitquire-dev'],
];

export function migrateLegacyHomeFolder(homeDir: string): LegacyDataFolderMigration {
  const moved: { from: string; to: string }[] = [];
  const kept: string[] = [];
  for (const [legacy, current] of LEGACY_HOME_DIRS) {
    const from = join(resolve(homeDir), legacy);
    if (!isRealDirectory(from)) continue;
    const to = join(resolve(homeDir), current);
    if (existsSync(to)) {
      kept.push(from);
      continue;
    }
    renameSync(from, to);
    moved.push({ from, to });
  }
  return { moved, kept, rewrittenIgnoreFiles: [] };
}

export function isMovedLegacyDataPath(projectDir: string, relativePath: string): boolean {
  const segments = relativePath.split('/');
  const index = segments.indexOf(LEGACY_DATA_DIR);
  if (index === -1 || index === segments.length - 1) return false;
  const legacyDir = join(projectDir, ...segments.slice(0, index + 1));
  return (
    !existsSync(legacyDir) && existsSync(join(projectDir, ...segments.slice(0, index), DATA_DIR))
  );
}

export function migrateLegacyDataFolders(projectDir: string): LegacyDataFolderMigration {
  const root = resolve(projectDir);
  const { moved, kept } = isRealDirectory(join(root, LEGACY_DATA_DIR))
    ? moveEach(legacyFoldersUnder(root))
    : { moved: [], kept: [] };
  const rewrittenIgnoreFiles: string[] = [];
  if (moved.length > 0) {
    const exclude = join(root, '.git', 'info', 'exclude');
    if (rewriteIgnoreFile(exclude)) rewrittenIgnoreFiles.push(exclude);
    repairMovedWorktrees(root, join(root, DATA_DIR));
  }
  return { moved, kept, rewrittenIgnoreFiles };
}

export function findLegacyProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, DATA_DIR, 'config.yml'))) return null;
    if (existsSync(join(dir, LEGACY_DATA_DIR, 'config.yml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function describeLegacyDataFolderMigration(result: LegacyDataFolderMigration): string[] {
  return [
    ...result.moved.map(
      ({ from, to }) => `Moved ${from} to ${to} (the data folder is now ${DATA_DIR}).`,
    ),
    ...result.kept.map(
      (from) =>
        `Left ${from} in place: ${join(dirname(from), DATA_DIR)} already exists. Move what you still need from it by hand.`,
    ),
    ...result.rewrittenIgnoreFiles.map(
      (path) => `Updated ${path} for the new ${DATA_DIR} folder name.`,
    ),
  ];
}
