import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DraftInstances } from './instances.ts';
import type { DraftRecord } from './model.ts';

export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

const IDENTITY = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com'];

export interface TestRepos {
  root: string;
  origin: string;
  live: string;
  drafts: string;
  commitLive: (path: string, content: string, email?: string) => void;
  pushFromElsewhere: (path: string, content: string) => void;
  cleanup: () => void;
}

export function createTestRepos(files: Record<string, string>): TestRepos {
  const root = mkdtempSync(join(tmpdir(), 'gq-drafts-'));
  const origin = join(root, 'origin.git');
  const live = join(root, 'live');
  const drafts = join(root, 'drafts');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin], root);
  git(['clone', '--quiet', origin, live], root);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(live, path), content);
  git(['add', '-A'], live);
  git([...IDENTITY, 'commit', '--quiet', '-m', 'init'], live);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], live);

  return {
    root,
    origin,
    live,
    drafts,
    commitLive: (path, content, email = 'tester@example.com') => {
      writeFileSync(join(live, path), content);
      git(['add', '-A'], live);
      git(
        [
          '-c',
          'user.name=Someone',
          '-c',
          `user.email=${email}`,
          'commit',
          '--quiet',
          '-m',
          `edit ${path}`,
        ],
        live,
      );
      git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], live);
    },
    pushFromElsewhere: (path, content) => {
      const other = join(root, `other-${Date.now()}`);
      git(['clone', '--quiet', origin, other], root);
      writeFileSync(join(other, path), content);
      git(['add', '-A'], other);
      git([...IDENTITY, 'commit', '--quiet', '-m', `remote edit ${path}`], other);
      git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], other);
      git(['pull', '--quiet', '--ff-only', 'origin', 'main'], live);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function fakeInstances(repos: TestRepos): DraftInstances & { halted: string[] } {
  const halted: string[] = [];
  const dir = (slug: string) => join(repos.drafts, slug);
  const prepareDir = async (draft: DraftRecord) => {
    if (existsSync(join(dir(draft.slug), '.git'))) return;
    git(['clone', '--quiet', '--branch', draft.branch, repos.origin, dir(draft.slug)], repos.root);
  };
  const erase = async (slug: string) => {
    rmSync(dir(slug), { recursive: true, force: true });
  };
  return {
    halted,
    dir,
    ensure: async (draft) => {
      await prepareDir(draft);
      return 1;
    },
    touch: () => undefined,
    hold: () => () => undefined,
    isRunning: () => false,
    stop: async () => undefined,
    remove: erase,
    halt: async (slug) => {
      halted.push(slug);
    },
    erase,
    prepareDir,
    exclusive: (_slug, work) => work(),
    stopAll: async () => undefined,
  };
}
