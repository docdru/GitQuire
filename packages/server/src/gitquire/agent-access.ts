import type { GateLogger } from './access-gate.ts';
import type { AgentTokenStore } from './agent-tokens.ts';
import type { GitHubAuthConfig } from './github-auth-config.ts';

export type AccessVerdict = 'allowed' | 'denied' | 'unknown';

export interface AccessCheckDeps {
  installationToken?: () => string | undefined;
  fetch?: typeof fetch;
}

const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);

export function createRepoAccessCheck(
  config: Pick<GitHubAuthConfig, 'allowedUsers' | 'repo' | 'githubApiUrl'>,
  deps: AccessCheckDeps,
): (login: string) => Promise<AccessVerdict> {
  const doFetch = deps.fetch ?? fetch;
  return async (login) => {
    if (config.allowedUsers.has(login.toLowerCase())) return 'allowed';
    if (config.repo === undefined) return 'denied';
    const token = deps.installationToken?.();
    if (token === undefined) return 'unknown';
    const owner = encodeURIComponent(config.repo.owner);
    const name = encodeURIComponent(config.repo.name);
    const user = encodeURIComponent(login);
    const url = `${config.githubApiUrl}/repos/${owner}/${name}/collaborators/${user}/permission`;
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'GitQuire',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      return 'unknown';
    }
    if (response.status === 404) return 'denied';
    if (response.status !== 200) return 'unknown';
    const body = (await response.json().catch(() => undefined)) as
      | { permission?: unknown; role_name?: unknown }
      | undefined;
    const role = typeof body?.role_name === 'string' ? body.role_name : body?.permission;
    return typeof role === 'string' && WRITE_ROLES.has(role) ? 'allowed' : 'denied';
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
  const timer = setInterval(() => {
    runOnce().catch((err: unknown) => {
      deps.log.warn({ err }, '[gitquire-agents] access check failed');
    });
  }, deps.intervalMs ?? 10 * 60 * 1000);
  timer.unref?.();
  return { runOnce, stop: () => clearInterval(timer) };
}
