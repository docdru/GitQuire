import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GitHubAppClient, GitHubAppConfig } from './github-app.ts';

export type RunGit = (args: readonly string[], cwd: string) => string;

export const runGitSync: RunGit = (args, cwd) =>
  execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
  });

export function basicAuthHeader(token: string): string {
  const credentials = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return `AUTHORIZATION: basic ${credentials}`;
}

export type BootstrapOutcome =
  | { action: 'cloned'; branch: string }
  | { action: 'initialized-empty'; branch: string }
  | { action: 'existing'; branch: string | undefined };

export interface BootstrapDeps {
  runGit?: RunGit;
  exists?: (path: string) => boolean;
}

export async function bootstrapRepository(
  dir: string,
  config: GitHubAppConfig,
  client: GitHubAppClient,
  deps: BootstrapDeps = {},
): Promise<BootstrapOutcome> {
  const runGit = deps.runGit ?? runGitSync;
  const exists = deps.exists ?? existsSync;
  const { token } = await client.mintInstallationToken();
  const info = await client.repoInfo(token);
  const withAuth = ['-c', `http.https://${config.gitHost}/.extraheader=${basicAuthHeader(token)}`];

  if (exists(join(dir, '.git'))) {
    const remotes = runGit(['remote'], dir)
      .split('\n')
      .map((line) => line.trim());
    if (remotes.includes('origin')) {
      runGit(['remote', 'set-url', 'origin', info.cloneUrl], dir);
    } else {
      runGit(['remote', 'add', 'origin', info.cloneUrl], dir);
    }
    let head = '';
    try {
      head = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir).trim();
    } catch {
      head = '';
    }
    return { action: 'existing', branch: head === '' ? undefined : head };
  }

  const branch = config.branch ?? info.defaultBranch;
  runGit(['init', '--initial-branch', branch], dir);
  runGit(['remote', 'add', 'origin', info.cloneUrl], dir);
  const remoteHead = runGit([...withAuth, 'ls-remote', '--heads', 'origin', branch], dir).trim();
  if (remoteHead === '') {
    return { action: 'initialized-empty', branch };
  }
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  runGit([...withAuth, 'fetch', '--no-tags', 'origin', refspec], dir);
  runGit(['checkout', '-B', branch, '--track', `origin/${branch}`], dir);
  return { action: 'cloned', branch };
}

export const AUTO_SYNC_MODES = ['off', 'follow', 'full'] as const;
export type AutoSyncMode = (typeof AUTO_SYNC_MODES)[number];

export function parseAutoSyncMode(value: string | undefined): AutoSyncMode {
  const mode = (value ?? '').trim().toLowerCase();
  if (mode === '') return 'full';
  if ((AUTO_SYNC_MODES as readonly string[]).includes(mode)) return mode as AutoSyncMode;
  throw new Error(
    `GITQUIRE_SYNC_MODE must be one of ${AUTO_SYNC_MODES.join(', ')}, got "${value}".`,
  );
}

export function ensureAutoSyncMode(dir: string, mode: AutoSyncMode): 'written' | 'kept' {
  const file = join(dir, '.ok', 'local', 'config.yml');
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8');
    if (/^autoSync\s*:/m.test(current)) return 'kept';
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    appendFileSync(file, `${separator}autoSync:\n  mode: ${mode}\n`);
    return 'written';
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `autoSync:\n  mode: ${mode}\n`);
  return 'written';
}
