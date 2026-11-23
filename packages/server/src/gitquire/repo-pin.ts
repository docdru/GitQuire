import type { GateLogger } from './access-gate.ts';
import type { HostRepo } from './host/types.ts';

export const REPO_ID_ENV = 'GITQUIRE_REPO_ID';

export interface RepoPinConfig {
  repoId: number;
  repo: HostRepo;
  apiUrl: string;
  originUrl: () => string | undefined;
}

export interface RepoPinDeps {
  token: () => string | undefined;
  log: GateLogger;
  fetch?: typeof fetch;
}

export function parseRepoId(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

function blocked(origin: string, repoId: number): string[] {
  return [`url.gitquire-unconfirmed://repository-${repoId}/.insteadOf=${origin}`];
}

function sameName(a: HostRepo, b: HostRepo): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
  );
}

function currentOf(body: unknown, repoId: number): HostRepo | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const r = body as { id?: unknown; name?: unknown; owner?: { login?: unknown } };
  if (r.id !== repoId || typeof r.name !== 'string') return undefined;
  if (typeof r.owner?.login !== 'string') return undefined;
  return { owner: r.owner.login, name: r.name };
}

function renamedUrl(origin: string, from: HostRepo, to: HostRepo): string | undefined {
  const suffix = `/${from.owner}/${from.name}.git`;
  if (!origin.toLowerCase().endsWith(suffix.toLowerCase())) return undefined;
  return `${origin.slice(0, origin.length - suffix.length)}/${to.owner}/${to.name}.git`;
}

export interface RepoPin {
  refresh: () => Promise<string[]>;
  current: () => string[];
}

export function withGitConfig(
  env: Record<string, string>,
  entries: readonly string[],
): Record<string, string> {
  if (entries.length === 0) return env;
  const out = { ...env };
  let count = Number(out.GIT_CONFIG_COUNT ?? '0');
  for (const entry of entries) {
    const at = entry.indexOf('=');
    out[`GIT_CONFIG_KEY_${count}`] = entry.slice(0, at);
    out[`GIT_CONFIG_VALUE_${count}`] = entry.slice(at + 1);
    count += 1;
  }
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}

export function createRepoPin(config: RepoPinConfig, deps: RepoPinDeps): RepoPin {
  const doFetch = deps.fetch ?? fetch;
  let lastNote = '';
  let last: string[] | undefined;

  function note(level: 'info' | 'warn', key: string, fields: object, message: string): void {
    if (lastNote === key) return;
    lastNote = key;
    deps.log[level]({ ...fields, repoId: config.repoId }, message);
  }

  async function check(): Promise<string[]> {
    const origin = config.originUrl();
    if (origin === undefined) return [];
    const token = deps.token();
    let current: HostRepo | undefined;
    try {
      const response = await doFetch(
        `${config.apiUrl}/repositories/${encodeURIComponent(String(config.repoId))}`,
        {
          headers: {
            accept: 'application/json',
            ...(token === undefined ? {} : { authorization: `token ${token}` }),
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      current =
        response.status === 200
          ? currentOf(await response.json().catch(() => undefined), config.repoId)
          : undefined;
    } catch {
      current = undefined;
    }
    if (current === undefined) {
      note(
        'warn',
        'unconfirmed',
        {},
        '[gitquire-sync] could not confirm this wiki’s repository by id; sync waits',
      );
      return blocked(origin, config.repoId);
    }
    if (sameName(current, config.repo)) {
      note('info', 'same', {}, '[gitquire-sync] repository confirmed by id');
      return [];
    }
    const url = renamedUrl(origin, config.repo, current);
    if (url === undefined) {
      note(
        'warn',
        'unmatched-origin',
        { origin },
        '[gitquire-sync] the origin address does not end with this wiki’s repository; sync waits',
      );
      return blocked(origin, config.repoId);
    }
    note(
      'warn',
      `renamed:${current.owner}/${current.name}`,
      { from: `${config.repo.owner}/${config.repo.name}`, to: `${current.owner}/${current.name}` },
      '[gitquire-sync] the repository was renamed; syncing with it under its new name until the front door restarts this wiki',
    );
    return [`url.${url}.insteadOf=${origin}`];
  }

  return {
    refresh: async () => {
      last = await check();
      return last;
    },
    current: () => {
      if (last !== undefined) return last;
      const origin = config.originUrl();
      return origin === undefined ? [] : blocked(origin, config.repoId);
    },
  };
}
