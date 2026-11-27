import { primaryVerifiedAddress } from './account-address.ts';
import type {
  AccountAddress,
  AddableRepo,
  AddableRepos,
  BotAccess,
  DoorHost,
  HostHealth,
  HostPerson,
  HostRepo,
  HostRepoRecord,
  HostRepoRef,
  Refusal,
  RepoAccess,
  RepoLookup,
  SelfCheck,
} from './types.ts';

export const FORGEJO_MIN_MAJOR = 15;
export const FORGEJO_SIGN_IN_SCOPE = 'read:user read:repository';
const WRITE_PERMISSIONS = new Set(['owner', 'admin', 'write']);
const ADMIN_PERMISSIONS = new Set(['owner', 'admin']);
const PAGE_LIMIT = 50;
const MAX_PAGES = 40;

export interface ForgejoDoorConfig {
  webUrl: string;
  apiUrl: string;
  repo: HostRepo | undefined;
}

export interface ForgejoRepoTokens {
  tokenFor: (repo: HostRepoRef) => string | undefined | Promise<string | undefined>;
}

export interface ForgejoDoorDeps {
  fetch?: typeof fetch;
  botToken?: () => string | undefined;
  repoToken?: () => string | undefined;
  repoTokens?: ForgejoRepoTokens;
}

function sameRepo(a: HostRepo, b: HostRepo): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
  );
}

function repoPath(repo: HostRepo): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function repoAddress(repo: HostRepoRef): string {
  return repo.id === undefined
    ? repoPath(repo)
    : `/repositories/${encodeURIComponent(String(repo.id))}`;
}

export function forgejoMajorVersion(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match === null ? undefined : Number(match[1]);
}

type Answer = { status: number; body: unknown; total?: number } | { status: 'unreachable' };

export function forgejoRepoRecord(body: unknown): HostRepoRecord | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const r = body as { id?: unknown; name?: unknown; owner?: { id?: unknown; login?: unknown } };
  if (typeof r.id !== 'number' || typeof r.name !== 'string') return undefined;
  if (typeof r.owner?.id !== 'number' || typeof r.owner.login !== 'string') return undefined;
  return { host: 'forgejo', id: r.id, owner: r.owner.login, ownerId: r.owner.id, name: r.name };
}

function permissionsOf(body: unknown): Record<string, unknown> | undefined {
  return (body as { permissions?: Record<string, unknown> } | undefined)?.permissions;
}

export function createForgejoDoorHost(
  config: ForgejoDoorConfig,
  deps: ForgejoDoorDeps = {},
): DoorHost {
  const doFetch = deps.fetch ?? fetch;

  function headers(token: string | undefined): Record<string, string> {
    return {
      Accept: 'application/json',
      'User-Agent': 'GitQuire',
      ...(token === undefined ? {} : { Authorization: `token ${token}` }),
    };
  }

  async function call(path: string, token: string | undefined): Promise<Answer> {
    let response: Response;
    try {
      response = await doFetch(`${config.apiUrl}${path}`, { headers: headers(token) });
    } catch {
      return { status: 'unreachable' };
    }
    if (response.status >= 500) return { status: 'unreachable' };
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { status: 'unreachable' };
    }
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    const total = Number(response.headers.get('x-total-count') ?? Number.NaN);
    return { status: response.status, body, ...(Number.isFinite(total) ? { total } : {}) };
  }

  async function strictCall(
    path: string,
    token: string,
  ): Promise<{ status: number; body: unknown }> {
    const response = await doFetch(`${config.apiUrl}${path}`, { headers: headers(token) });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  async function person(token: string): Promise<HostPerson | undefined> {
    const { status, body } = await strictCall('/user', token);
    if (status !== 200 || typeof body !== 'object' || body === null) return undefined;
    const u = body as Record<string, unknown>;
    if (typeof u.id !== 'number' || typeof u.login !== 'string') return undefined;
    const fullName = typeof u.full_name === 'string' ? u.full_name.trim() : '';
    const avatarUrl = typeof u.avatar_url === 'string' ? u.avatar_url : '';
    return { id: u.id, login: u.login, name: fullName === '' ? u.login : fullName, avatarUrl };
  }

  async function accountAddress(token: string): Promise<AccountAddress> {
    try {
      const { status, body } = await strictCall('/user/emails', token);
      return primaryVerifiedAddress(status, body);
    } catch {
      return { state: 'unreachable' };
    }
  }

  function levelFrom(permissions: Record<string, unknown> | undefined): RepoAccess {
    if (permissions?.admin === true) return 'admin';
    return permissions?.push === true ? 'write' : 'none';
  }

  async function access(token: string, repo: HostRepoRef): Promise<RepoAccess> {
    const { status, body } = await strictCall(repoAddress(repo), token);
    if (status !== 200 || typeof body !== 'object' || body === null) return 'none';
    return levelFrom((body as { permissions?: Record<string, unknown> }).permissions);
  }

  async function botReachesRepo(repo: HostRepoRef, token: string): Promise<BotAccess> {
    const answer = await call(repoAddress(repo), token);
    if (answer.status === 'unreachable') return 'unreachable';
    if (answer.status === 200) return 'none';
    if (answer.status === 401) return 'refused:token';
    if (answer.status === 403 || answer.status === 404) return 'refused:removed';
    return 'unreachable';
  }

  async function currentName(
    repo: HostRepoRef,
    token: string,
  ): Promise<HostRepo | `refused:${Refusal}` | 'unreachable'> {
    if (repo.id === undefined) return repo;
    const answer = await call(`/repositories/${encodeURIComponent(String(repo.id))}`, token);
    if (answer.status === 'unreachable') return 'unreachable';
    if (answer.status === 401) return 'refused:token';
    if (answer.status === 403) return 'refused:not-admin';
    if (answer.status === 404) return 'refused:removed';
    const found = answer.status === 200 ? forgejoRepoRecord(answer.body) : undefined;
    return found === undefined ? 'unreachable' : { owner: found.owner, name: found.name };
  }

  async function accessByBot(login: string, repo: HostRepoRef): Promise<BotAccess> {
    const token = deps.botToken?.();
    if (token === undefined) return 'unreachable';
    const named = await currentName(repo, token);
    if (typeof named === 'string') return named;
    const answer = await call(
      `${repoPath(named)}/collaborators/${encodeURIComponent(login)}/permission`,
      token,
    );
    if (answer.status === 'unreachable') return 'unreachable';
    if (answer.status === 404) return botReachesRepo(repo, token);
    if (answer.status === 401) return 'refused:token';
    if (answer.status === 403) return 'refused:not-admin';
    if (answer.status !== 200) return 'unreachable';
    const permission = (answer.body as { permission?: unknown } | undefined)?.permission;
    if (typeof permission !== 'string' || !WRITE_PERMISSIONS.has(permission)) return 'none';
    return ADMIN_PERMISSIONS.has(permission) ? 'admin' : 'write';
  }

  async function tokenFor(repo: HostRepoRef): Promise<string | undefined> {
    if (deps.repoTokens === undefined) {
      return config.repo !== undefined && sameRepo(repo, config.repo)
        ? deps.repoToken?.()
        : undefined;
    }
    const token = await deps.repoTokens.tokenFor(repo);
    if (token === undefined || token === '' || token === deps.botToken?.()) return undefined;
    return token;
  }

  async function repoById(id: number): Promise<RepoLookup> {
    const bot = deps.botToken?.();
    if (bot === undefined) return { state: 'refused', refusal: 'token' };
    const answer = await call(`/repositories/${encodeURIComponent(String(id))}`, bot);
    if (answer.status === 'unreachable') return { state: 'unreachable' };
    if (answer.status === 401) return { state: 'refused', refusal: 'token' };
    if (answer.status === 403 || answer.status === 404) return { state: 'gone' };
    const repo = answer.status === 200 ? forgejoRepoRecord(answer.body) : undefined;
    return repo === undefined ? { state: 'unreachable' } : { state: 'found', repo };
  }

  async function health(repo: HostRepoRef): Promise<HostHealth> {
    const bot = deps.botToken?.();
    if (bot === undefined) return 'refused:token';
    const byBot = await call(repoAddress(repo), bot);
    if (byBot.status === 'unreachable') return 'unreachable';
    if (byBot.status === 401) return 'refused:token';
    if (byBot.status === 403 || byBot.status === 404) return 'refused:removed';
    if (byBot.status !== 200) return 'unreachable';
    if (permissionsOf(byBot.body)?.admin !== true) return 'refused:not-admin';
    const limited = await tokenFor(repo);
    if (limited === undefined) return 'refused:token';
    const byLimited = await call(repoAddress(repo), limited);
    if (byLimited.status === 'unreachable') return 'unreachable';
    if (byLimited.status !== 200) return 'refused:token';
    return permissionsOf(byLimited.body)?.push === true ? 'ok' : 'refused:token';
  }

  async function addableRepos(personToken: string): Promise<AddableRepos> {
    const candidates: HostRepoRecord[] = [];
    let seen = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const answer = await call(`/user/repos?limit=${PAGE_LIMIT}&page=${page}`, personToken);
      if (answer.status === 'unreachable') return { state: 'unreachable' };
      if (answer.status === 401 || answer.status === 403) {
        return { state: 'refused', whose: 'person' };
      }
      if (answer.status !== 200 || !Array.isArray(answer.body)) return { state: 'unreachable' };
      for (const item of answer.body) {
        const record = forgejoRepoRecord(item);
        if (record !== undefined && permissionsOf(item)?.admin === true) candidates.push(record);
      }
      seen += answer.body.length;
      if (answer.body.length === 0 || (answer.total !== undefined && seen >= answer.total)) break;
    }
    const bot = deps.botToken?.();
    if (bot === undefined) return { state: 'refused', whose: 'gitquire' };
    const repos: AddableRepo[] = [];
    for (const candidate of candidates) {
      const answer = await call(`/repositories/${candidate.id}`, bot);
      if (answer.status === 'unreachable') return { state: 'unreachable' };
      if (answer.status === 401) return { state: 'refused', whose: 'gitquire' };
      if (answer.status !== 200) continue;
      const current = forgejoRepoRecord(answer.body) ?? candidate;
      repos.push(
        permissionsOf(answer.body)?.admin === true
          ? current
          : { ...current, blocked: 'bot-not-admin' },
      );
    }
    return { state: 'listed', repos };
  }

  async function selfCheck(): Promise<SelfCheck> {
    const problems: string[] = [];
    const version = await call('/version', deps.botToken?.());
    if (version.status === 'unreachable') {
      return {
        ok: false,
        unreachable: true,
        problems: [`Forgejo at ${config.apiUrl} cannot be reached.`],
      };
    }
    const raw = (version.body as { version?: unknown } | undefined)?.version;
    const major = typeof raw === 'string' ? forgejoMajorVersion(raw) : undefined;
    if (major === undefined || major < FORGEJO_MIN_MAJOR) {
      problems.push(
        `GitQuire needs Forgejo ${FORGEJO_MIN_MAJOR} or later; ${config.apiUrl}/version answered ${typeof raw === 'string' ? raw : `HTTP ${version.status}`}.`,
      );
    }
    if (config.repo !== undefined) {
      const label = `${config.repo.owner}/${config.repo.name}`;
      const bot = deps.botToken?.();
      if (bot === undefined) {
        problems.push("GITQUIRE_HOST_TOKEN (the bot account's token) is not set.");
      } else {
        const answer = await call(repoPath(config.repo), bot);
        if (answer.status === 'unreachable') {
          return {
            ok: false,
            unreachable: true,
            problems: [`Forgejo at ${config.apiUrl} cannot be reached.`],
          };
        }
        const permissions = (answer.body as { permissions?: Record<string, unknown> } | undefined)
          ?.permissions;
        if (answer.status !== 200) {
          problems.push(
            `The bot account cannot see ${label} (HTTP ${answer.status}). Add it to the repository as an administrator and check GITQUIRE_HOST_TOKEN.`,
          );
        } else if (permissions?.admin !== true) {
          problems.push(
            `The bot account must be an administrator of ${label} so GitQuire can check people's access; it has ${permissions?.push === true ? 'write' : 'read'} access.`,
          );
        }
      }
      const repoToken = deps.repoToken?.();
      if (repoToken === undefined) {
        problems.push(`GITQUIRE_HOST_REPO_TOKEN (the token limited to ${label}) is not set.`);
      } else {
        const answer = await call(repoPath(config.repo), repoToken);
        if (answer.status === 'unreachable') {
          return {
            ok: false,
            unreachable: true,
            problems: [`Forgejo at ${config.apiUrl} cannot be reached.`],
          };
        }
        const permissions = (answer.body as { permissions?: Record<string, unknown> } | undefined)
          ?.permissions;
        if (answer.status !== 200 || permissions?.push !== true) {
          problems.push(
            `GITQUIRE_HOST_REPO_TOKEN cannot write to ${label} (HTTP ${answer.status}). Create a token for the bot limited to this repository with write:repository.`,
          );
        }
      }
    }
    return problems.length === 0 ? { ok: true } : { ok: false, unreachable: false, problems };
  }

  return {
    authorizeUrl: ({ clientId, redirectUri, state }) => {
      const authorize = new URL(`${config.webUrl}/login/oauth/authorize`);
      authorize.searchParams.set('client_id', clientId);
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('scope', FORGEJO_SIGN_IN_SCOPE);
      authorize.searchParams.set('state', state);
      return authorize.toString();
    },
    exchangeCode: async ({ clientId, clientSecret, code, redirectUri }) => {
      const response = await doFetch(`${config.webUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'GitQuire',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      const token = (body as { access_token?: unknown } | undefined)?.access_token;
      return typeof token === 'string' && token !== '' ? token : undefined;
    },
    person,
    accountAddress,
    access,
    accessByBot,
    addableRepos,
    repoById,
    health,
    tokenFor,
    selfCheck,
    accountExists: async (name) => {
      const bot = deps.botToken?.();
      for (const path of [
        `/users/${encodeURIComponent(name)}`,
        `/orgs/${encodeURIComponent(name)}`,
      ]) {
        const answer = await call(path, bot);
        if (answer.status === 200) return 'found';
        if (answer.status !== 404) return 'unknown';
      }
      return 'missing';
    },
  };
}
