import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import { authHeaderEnv } from '../repo-bootstrap.ts';
import type { WikiRecord } from './wiki-table.ts';

export const BRANCH_WATCH_MS = 10 * 60 * 1000;
export const BRANCH_WATCH_MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 30_000;

export type RunGitAsync = (
  args: readonly string[],
  cwd: string,
  extraEnv?: Readonly<Record<string, string>>,
) => Promise<string>;

export const runGitAsync: RunGitAsync = (args, cwd, extraEnv = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });

export interface BranchWatchDeps {
  wikis: () => readonly WikiRecord[];
  isRunning: (key: string) => boolean;
  dirOf: (wiki: WikiRecord) => string;
  gitHostOf: (wiki: WikiRecord) => string | undefined;
  tokenFor: (wiki: WikiRecord) => Promise<string | undefined>;
  wake: (wiki: WikiRecord) => Promise<void>;
  log: Pick<GateLogger, 'info' | 'warn'>;
  runGit?: RunGitAsync;
  now?: () => number;
  intervalMs?: number;
  maxBackoffMs?: number;
}

export interface BranchWatch {
  round: () => Promise<number>;
}

export function createBranchWatch(deps: BranchWatchDeps): BranchWatch {
  const runGit = deps.runGit ?? runGitAsync;
  const now = deps.now ?? Date.now;
  const interval = deps.intervalMs ?? BRANCH_WATCH_MS;
  const maxBackoff = deps.maxBackoffMs ?? BRANCH_WATCH_MAX_BACKOFF_MS;
  const failures = new Map<string, { count: number; retryAt: number }>();
  let running = false;

  async function moved(wiki: WikiRecord): Promise<boolean> {
    const dir = deps.dirOf(wiki);
    if (!existsSync(join(dir, '.git'))) return false;
    const upstream = (await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], dir)).trim();
    if (!upstream.startsWith('origin/')) return false;
    const branch = upstream.slice('origin/'.length);
    const known = (await runGit(['rev-parse', '@{upstream}'], dir)).trim();
    const gitHost = deps.gitHostOf(wiki);
    const token = await deps.tokenFor(wiki);
    if (gitHost === undefined || token === undefined) throw new Error('no token for the wiki');
    const answer = await runGit(
      ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
      dir,
      authHeaderEnv(gitHost, token),
    );
    const remote = answer.trim().split(/\s+/)[0] ?? '';
    return remote !== '' && remote !== known;
  }

  return {
    round: async () => {
      if (running) return 0;
      running = true;
      let woken = 0;
      try {
        for (const wiki of deps.wikis()) {
          if (wiki.state !== 'on' || deps.isRunning(wiki.key)) continue;
          if ((failures.get(wiki.key)?.retryAt ?? 0) > now()) continue;
          try {
            if (!(await moved(wiki))) {
              failures.delete(wiki.key);
              continue;
            }
            failures.delete(wiki.key);
            deps.log.info(
              { wiki: wiki.key },
              '[gitquire-wikis] branch moved on the host: waking the wiki',
            );
            await deps.wake(wiki);
            woken += 1;
          } catch (err) {
            const count = (failures.get(wiki.key)?.count ?? 0) + 1;
            failures.set(wiki.key, {
              count,
              retryAt: now() + Math.min(maxBackoff, interval * 2 ** (count - 1)),
            });
            deps.log.warn(
              {
                wiki: wiki.key,
                failures: count,
                reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
              },
              '[gitquire-wikis] could not check a sleeping wiki on the host',
            );
          }
        }
      } finally {
        running = false;
      }
      return woken;
    },
  };
}
