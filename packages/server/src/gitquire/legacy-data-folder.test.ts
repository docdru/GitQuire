import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  describeLegacyDataFolderMigration,
  findLegacyProjectRoot,
  migrateLegacyDataFolders,
  migrateLegacyHomeFolder,
} from './legacy-data-folder.ts';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-legacy-data-'));
  dirs.push(dir);
  return dir;
}

function write(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('moves the project, nested folder and home data folders and keeps their contents', () => {
  const project = scratch();
  const home = scratch();
  write(project, '.ok/config.yml', 'content:\n  dir: .\n');
  write(project, '.ok/local/state.json', '{}');
  write(project, 'marketing/.ok/templates/post.md', '# Post\n');
  write(home, '.ok/auth.yml', 'hosts: {}\n');

  const result = migrateLegacyDataFolders(project);
  const homeResult = migrateLegacyHomeFolder(home);

  expect(result.moved.map(({ to }) => to).sort()).toEqual(
    [join(project, '.gitquire'), join(project, 'marketing', '.gitquire')].sort(),
  );
  expect(homeResult.moved).toEqual([{ from: join(home, '.ok'), to: join(home, '.gitquire') }]);
  expect(readFileSync(join(project, '.gitquire/config.yml'), 'utf8')).toBe('content:\n  dir: .\n');
  expect(existsSync(join(project, '.gitquire/local/state.json'))).toBe(true);
  expect(existsSync(join(project, 'marketing/.gitquire/templates/post.md'))).toBe(true);
  expect(existsSync(join(home, '.gitquire/auth.yml'))).toBe(true);
  expect(existsSync(join(project, '.ok'))).toBe(false);
});

test('leaves an old folder in place when the new one already exists', () => {
  const project = scratch();
  write(project, '.ok/config.yml', 'old\n');
  write(project, '.gitquire/config.yml', 'new\n');

  const result = migrateLegacyDataFolders(project);

  expect(result.moved).toEqual([]);
  expect(result.kept).toEqual([join(project, '.ok')]);
  expect(readFileSync(join(project, '.gitquire/config.yml'), 'utf8')).toBe('new\n');
  expect(describeLegacyDataFolderMigration(result)[0]).toContain('already exists');
});

test('rewrites ignore entries that name the old folder, and nothing else', () => {
  const project = scratch();
  write(project, '.ok/config.yml', 'x\n');
  write(
    project,
    '.gitignore',
    '.DS_Store\n.ok/local/\n/docs/.ok/cache\n!.ok/templates\n# .ok/ is the data folder\nbook.okay\n',
  );

  const result = migrateLegacyDataFolders(project);

  expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe(
    '.DS_Store\n.gitquire/local/\n/docs/.gitquire/cache\n!.gitquire/templates\n# .ok/ is the data folder\nbook.okay\n',
  );
  expect(result.rewrittenIgnoreFiles).toEqual([join(project, '.gitignore')]);
});

test('does nothing in a project that already uses the new folder', () => {
  const project = scratch();
  write(project, '.gitquire/config.yml', 'x\n');
  write(project, '.gitignore', '.ok/local/\n');

  expect(migrateLegacyDataFolders(project)).toEqual({
    moved: [],
    kept: [],
    rewrittenIgnoreFiles: [],
  });
  expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('.ok/local/\n');
});

test('skips git internals, dependencies and draft folders', () => {
  const project = scratch();
  write(project, '.git/ok-internal/.ok/x', 'x');
  write(project, 'node_modules/pkg/.ok/x', 'x');
  write(project, '.gitquire-drafts/alice/.ok/x', 'x');

  expect(migrateLegacyDataFolders(project).moved).toEqual([]);
  expect(existsSync(join(project, 'node_modules/pkg/.ok/x'))).toBe(true);
});

test('the moved project is still a git working copy whose history sees the rename', () => {
  const project = scratch();
  write(project, '.ok/config.yml', 'x\n');
  write(project, 'index.md', '# Home\n');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: project,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');

  migrateLegacyDataFolders(project);
  git('add', '-A');

  expect(git('status', '--porcelain').trim()).toBe('R  .ok/config.yml -> .gitquire/config.yml');
});

test('finds the root of a project that still has the old folder', () => {
  const project = scratch();
  write(project, '.ok/config.yml', 'x\n');
  mkdirSync(join(project, 'notes', 'deep'), { recursive: true });

  expect(findLegacyProjectRoot(join(project, 'notes', 'deep'))).toBe(project);
  migrateLegacyDataFolders(project);
  expect(findLegacyProjectRoot(join(project, 'notes', 'deep'))).toBeNull();
});
