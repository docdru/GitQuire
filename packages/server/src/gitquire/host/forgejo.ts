import type { BotAccess, DoorHost, HostPerson, HostRepo, RepoAccess, SelfCheck } from './types.ts';

export const FORGEJO_MIN_MAJOR = 15;
export const FORGEJO_SIGN_IN_SCOPE = 'read:user read:repository';
const WRITE_PERMISSIONS = new Set(['owner', 'admin', 'write']);
const ADMIN_PERMISSIONS = new Set(['owner', 'admin']);

export interface ForgejoDoorConfig {
  webUrl: string;
  apiUrl: string;
  repo: HostRepo | undefined;
}

export interface ForgejoDoorDeps {
  fetch?: typeof fetch;
  botToken?: () => string | undefined;
  repoToken?: () => string | undefined;
}

function sameRepo(a: HostRepo, b: HostRepo): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
  );
}

function repoPath(repo: HostRepo): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

export function forgejoMajorVersion(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match === null ? undefined : Number(match[1]);
}

type Answer = { status: number; body: unknown } | { status: 'unreachable' };

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
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
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

  function levelFrom(permissions: Record<string, unknown> | undefined): RepoAccess {
    if (permissions?.admin === true) return 'admin';
    return permissions?.push === true ? 'write' : 'none';
  }

  async function access(token: string, repo: HostRepo): Promise<RepoAccess> {
    const { status, body } = await strictCall(repoPath(repo), token);
    if (status !== 200 || typeof body !== 'object' || body === null) return 'none';
    return levelFrom((body as { permissions?: Record<string, unknown> }).permissions);
  }

  async function botReachesRepo(repo: HostRepo, token: string): Promise<BotAccess> {
    const answer = await call(repoPath(repo), token);
    if (answer.status === 'unreachable') return 'unreachable';
    if (answer.status === 200) return 'none';
    if (answer.status === 401) return 'refused:token';
    if (answer.status === 403 || answer.status === 404) return 'refused:removed';
    return 'unreachable';
  }

  async function accessByBot(login: string, repo: HostRepo): Promise<BotAccess> {
    const token = deps.botToken?.();
    if (token === undefined) return 'unreachable';
    const answer = await call(
      `${repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`,
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
    access,
    accessByBot,
    tokenFor: async (repo) =>
      config.repo !== undefined && sameRepo(repo, config.repo) ? deps.repoToken?.() : undefined,
    selfCheck,
  };
}
