import type { GateLogger } from './access-gate.ts';
import type { AgentTokenStore } from './agent-tokens.ts';
import type { GitHubAuthConfig } from './github-auth-config.ts';
import { createGitHubDoorHost } from './host/github.ts';
import type { BotAccess, DoorHost } from './host/types.ts';

export type AccessVerdict = 'allowed' | 'denied' | 'unknown';

export interface AccessCheckDeps {
  installationToken?: () => string | undefined;
  fetch?: typeof fetch;
  host?: DoorHost;
}

export function verdictFor(access: BotAccess): AccessVerdict {
  if (access === 'write' || access === 'admin') return 'allowed';
  if (access === 'none') return 'denied';
  return 'unknown';
}

export function createRepoAccessCheck(
  config: Pick<GitHubAuthConfig, 'allowedUsers' | 'repo' | 'githubApiUrl'> &
    Partial<Pick<GitHubAuthConfig, 'githubWebUrl'>>,
  deps: AccessCheckDeps,
): (login: string) => Promise<AccessVerdict> {
  const host =
    deps.host ??
    createGitHubDoorHost(
      {
        webUrl: config.githubWebUrl ?? 'https://github.com',
        apiUrl: config.githubApiUrl,
        repo: config.repo,
      },
      { fetch: deps.fetch, installationToken: deps.installationToken },
    );
  return async (login) => {
    if (config.allowedUsers.has(login.toLowerCase())) return 'allowed';
    if (config.repo === undefined) return 'denied';
    return verdictFor(await host.accessByBot(login, config.repo));
  };
}

export interface AccessSweep {
  runOnce: () => Promise<number>;
  stop: () => void;
}

export function startAccessSweep(
  store: AgentTokenStore,
  check: (login: string) => Promise<AccessVerdict>,
  deps: { log: GateLogger; intervalMs?: number },
): AccessSweep {
  let running = false;
  async function runOnce(): Promise<number> {
    if (running) return 0;
    running = true;
    let revoked = 0;
    try {
      for (const owner of store.owners()) {
        const verdict = await check(owner.login);
        if (verdict !== 'denied') continue;
        const removed = store.revokeOwner(owner.id);
        revoked += removed;
        deps.log.warn(
          { login: owner.login, removed },
          '[gitquire-agents] revoked agent access: user no longer has access to the repository',
        );
      }
    } finally {
      running = false;
    }
    return revoked;
  }
  const timer = setInterval(
    () => {
      runOnce().catch((err: unknown) => {
        deps.log.warn({ err }, '[gitquire-agents] access check failed');
      });
    },
    deps.intervalMs ?? 10 * 60 * 1000,
  );
  timer.unref?.();
  return { runOnce, stop: () => clearInterval(timer) };
}
