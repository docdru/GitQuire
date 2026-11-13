import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { goneBranches, mergedGoneBranches } from './merged-branches.ts';
import { createGitQuireRoutes } from './routes.ts';

const dirs: string[] = [];

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function commit(cwd: string, file: string, text: string): void {
  writeFileSync(join(cwd, file), text);
  run(cwd, 'add', file);
  run(cwd, 'commit', '-q', '-m', `edit ${file}`);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gq-merged-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const other = join(root, 'other');
  run(root, 'init', '-q', '--bare', '--initial-branch=main', origin);
  run(root, 'clone', '-q', origin, work);
  run(work, 'checkout', '-q', '-b', 'main');
  commit(work, 'a.md', 'one\n');
  run(work, 'push', '-q', '-u', 'origin', 'main');
  for (const branch of ['merged', 'squashed', 'open']) {
    run(work, 'checkout', '-q', '-b', branch, 'main');
    commit(work, `${branch}.md`, `${branch}\n`);
    run(work, 'push', '-q', '-u', 'origin', branch);
  }
  run(work, 'checkout', '-q', 'main');
  run(root, 'clone', '-q', origin, other);
  run(other, 'merge', '-q', '--no-edit', 'origin/merged');
  run(other, 'push', '-q', 'origin', 'main', ':merged', ':squashed');
  run(work, '-c', 'fetch.prune=true', 'fetch', '-q', 'origin');
  const git = (args: readonly string[]) => run(work, ...args);
  return { git, work };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('merged branches', () => {
  it('finds local branches whose GitHub branch is gone', () => {
    const { git } = setup();
    expect(goneBranches(git).map((branch) => branch.name)).toEqual(['merged', 'squashed']);
  });

  it('counts a branch as merged when main has it or a merged PR had its tip', async () => {
    const { git } = setup();
    expect(await mergedGoneBranches(git, 'main')).toEqual(['merged']);
    const squashedTip = git(['rev-parse', 'squashed']).trim();
    const heads = async (branch: string) => (branch === 'squashed' ? [squashedTip] : []);
    expect(await mergedGoneBranches(git, 'main', heads)).toEqual(['merged', 'squashed']);
  });

  it('keeps a gone branch with commits that were never merged', async () => {
    const { git, work } = setup();
    run(work, 'checkout', '-q', 'squashed');
    commit(work, 'later.md', 'after the merge\n');
    const heads = async () => ['0000000000000000000000000000000000000000'];
    expect(await mergedGoneBranches(git, 'main', heads)).toEqual(['merged']);
  });

  it('removes merged branches and flags a merged current branch', async () => {
    const { git, work } = setup();
    const routes = createGitQuireRoutes({
      projectDir: work,
      baseBranch: 'main',
      log: { info: () => {}, warn: () => {}, error: () => {} },
      env: {},
    });
    const list = async () => {
      const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
      const res = {
        headersSent: false,
        writableEnded: false,
        writeHead() {
          return res;
        },
        end(chunk: string) {
          resolve(JSON.parse(chunk));
          return res;
        },
      };
      const req = { url: '/api/gitquire/branches', method: 'GET', headers: {} };
      routes.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      return promise;
    };
    run(work, 'checkout', '-q', 'merged');
    expect(await list()).toMatchObject({ current: 'merged', currentMerged: true });
    run(work, 'checkout', '-q', 'main');
    expect(await list()).toMatchObject({
      current: 'main',
      currentMerged: false,
      local: ['main', 'open', 'squashed'],
    });
    expect(git(['branch', '--list', 'merged']).trim()).toBe('');
    routes.stop();
  });
});
