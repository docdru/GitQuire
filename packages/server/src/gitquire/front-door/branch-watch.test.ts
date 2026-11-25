import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBranchWatch } from './branch-watch.ts';
import type { WikiRecord } from './wiki-table.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.org',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.org',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

function repos() {
  const root = mkdtempSync(join(tmpdir(), 'gq-branch-watch-'));
  dirs.push(root);
  const remote = join(root, 'remote.git');
  git(['init', '--bare', '--initial-branch', 'main', remote], root);
  const author = join(root, 'author');
  git(['clone', remote, author], root);
  writeFileSync(join(author, 'plan.md'), '# Plan\n');
  git(['add', '.'], author);
  git(['commit', '-m', 'first'], author);
  git(['push', 'origin', 'main'], author);
  const wiki = join(root, 'wiki');
  git(['clone', remote, wiki], root);
  return {
    wiki,
    push: (text: string) => {
      writeFileSync(join(author, 'plan.md'), text);
      git(['commit', '-am', 'change'], author);
      git(['push', 'origin', 'main'], author);
    },
    breakRemote: () => rmSync(remote, { recursive: true, force: true }),
  };
}

const record = { key: 'github-1', state: 'on', owner: 'team', name: 'a' } as unknown as WikiRecord;

function watch(dir: string, options: { running?: boolean; token?: string | undefined } = {}) {
  const woken: string[] = [];
  const warnings: string[] = [];
  let at = 0;
  const instance = createBranchWatch({
    wikis: () => [record],
    isRunning: () => options.running ?? false,
    dirOf: () => dir,
    gitHostOf: () => 'git.example.org',
    tokenFor: async () => ('token' in options ? options.token : 'secret-token'),
    wake: async (wiki) => {
      woken.push(wiki.key);
    },
    log: {
      info: () => {},
      warn: (fields: unknown) => warnings.push(JSON.stringify(fields)),
    },
    now: () => at,
    intervalMs: 1000,
    maxBackoffMs: 4000,
  });
  return { instance, woken, warnings, advance: (ms: number) => (at += ms) };
}

describe('waking a sleeping wiki when its branch moved on the host', () => {
  it('wakes it only when the host has commits the wiki has not fetched', async () => {
    const { wiki, push } = repos();
    const { instance, woken } = watch(wiki);
    expect(await instance.round()).toBe(0);
    push('# Plan\n\n@anna look\n');
    expect(await instance.round()).toBe(1);
    expect(woken).toEqual(['github-1']);
    git(['pull', '--ff-only'], wiki);
    expect(await instance.round()).toBe(0);
  });

  it('leaves a running wiki alone: it pulls by itself', async () => {
    const { wiki, push } = repos();
    push('# Plan\n\nmore\n');
    const { instance, woken } = watch(wiki, { running: true });
    expect(await instance.round()).toBe(0);
    expect(woken).toEqual([]);
  });

  it('backs off when the host cannot be asked, and says so without the token', async () => {
    const { wiki, breakRemote } = repos();
    breakRemote();
    const { instance, warnings, advance } = watch(wiki);
    await instance.round();
    expect(warnings).toHaveLength(1);
    await instance.round();
    expect(warnings).toHaveLength(1);
    advance(1000);
    await instance.round();
    expect(warnings).toHaveLength(2);
    advance(1000);
    await instance.round();
    expect(warnings).toHaveLength(2);
    advance(1000);
    await instance.round();
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).not.toContain('secret-token');
  });

  it('does nothing without a token for the wiki', async () => {
    const { wiki, push } = repos();
    push('# Plan\n\nmore\n');
    const { instance, woken, warnings } = watch(wiki, { token: undefined });
    expect(await instance.round()).toBe(0);
    expect(woken).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
