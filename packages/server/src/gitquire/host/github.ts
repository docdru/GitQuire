import type { BotAccess, DoorHost, HostNames, HostPerson, HostRepo, RepoAccess } from './types.ts';

const GITHUB_API_VERSION = '2022-11-28';
const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);
const ADMIN_ROLES = new Set(['admin', 'maintain']);

export interface GitHubDoorConfig {
  names: HostNames;
  webUrl: string;
  apiUrl: string;
  repo: HostRepo | undefined;
}

export interface GitHubDoorDeps {
  fetch?: typeof fetch;
  botToken?: () => string | undefined;
}

function sameRepo(a: HostRepo, b: HostRepo): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
  );
}

function repoPath(repo: HostRepo): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

export function createGitHubDoorHost(
  config: GitHubDoorConfig,
  deps: GitHubDoorDeps = {},
): DoorHost {
  const doFetch = deps.fetch ?? fetch;

  async function json(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const response = await doFetch(url, init);
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  function apiHeaders(token: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'GitQuire',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
  }

  async function person(token: string): Promise<HostPerson | undefined> {
    const { status, body } = await json(`${config.apiUrl}/user`, { headers: apiHeaders(token) });
    if (status !== 200 || typeof body !== 'object' || body === null) return undefined;
    const u = body as Record<string, unknown>;
    if (typeof u.id !== 'number' || typeof u.login !== 'string') return undefined;
    const name = typeof u.name === 'string' && u.name.trim() !== '' ? u.name : u.login;
    const avatarUrl = typeof u.avatar_url === 'string' ? u.avatar_url : '';
    return { id: u.id, login: u.login, name, avatarUrl };
  }

  async function access(token: string, repo: HostRepo): Promise<RepoAccess> {
    const { status, body } = await json(`${config.apiUrl}${repoPath(repo)}`, {
      headers: apiHeaders(token),
    });
    if (status !== 200 || typeof body !== 'object' || body === null) return 'none';
    const permissions = (body as { permissions?: Record<string, unknown> }).permissions;
    if (permissions?.admin === true || permissions?.maintain === true) return 'admin';
    return permissions?.push === true ? 'write' : 'none';
  }

  async function accessByBot(login: string, repo: HostRepo): Promise<BotAccess> {
    const token = deps.botToken?.();
    if (token === undefined) return 'unreachable';
    const url = `${config.apiUrl}${repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`;
    let response: Response;
    try {
      response = await doFetch(url, { headers: apiHeaders(token) });
    } catch {
      return 'unreachable';
    }
    if (response.status === 404) return 'none';
    if (response.status === 401 || response.status === 403) return 'refused';
    if (response.status !== 200) return 'unreachable';
    const body = (await response.json().catch(() => undefined)) as
      | { permission?: unknown; role_name?: unknown }
      | undefined;
    const role = typeof body?.role_name === 'string' ? body.role_name : body?.permission;
    if (typeof role !== 'string' || !WRITE_ROLES.has(role)) return 'none';
    return ADMIN_ROLES.has(role) ? 'admin' : 'write';
  }

  return {
    names: config.names,
    authorizeUrl: ({ clientId, redirectUri, state }) => {
      const authorize = new URL(`${config.webUrl}/login/oauth/authorize`);
      authorize.searchParams.set('client_id', clientId);
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('allow_signup', 'false');
      return authorize.toString();
    },
    exchangeCode: async ({ clientId, clientSecret, code, redirectUri }) => {
      const { body } = await json(`${config.webUrl}/login/oauth/access_token`, {
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
          redirect_uri: redirectUri,
        }),
      });
      const token = (body as { access_token?: unknown } | undefined)?.access_token;
      return typeof token === 'string' && token !== '' ? token : undefined;
    },
    person,
    access,
    accessByBot,
    tokenFor: (repo) =>
      config.repo !== undefined && sameRepo(repo, config.repo) ? deps.botToken?.() : undefined,
  };
}
