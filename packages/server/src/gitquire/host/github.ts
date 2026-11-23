import type {
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
} from './types.ts';

const GITHUB_API_VERSION = '2022-11-28';
const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);
const ADMIN_ROLES = new Set(['admin', 'maintain']);
const PER_PAGE = 100;
const MAX_PAGES = 20;
export const RENEW_BEFORE_EXPIRY_MS = 10 * 60 * 1000;

export interface GitHubDoorConfig {
  webUrl: string;
  apiUrl: string;
  repo: HostRepo | undefined;
}

export interface GitHubAppAuth {
  jwt: () => string;
}

export interface GitHubDoorDeps {
  fetch?: typeof fetch;
  installationToken?: () => string | undefined;
  app?: GitHubAppAuth;
  now?: () => number;
}

type Answer = { status: number; body: unknown } | { status: 'unreachable' };

type Minted =
  | { state: 'ok'; token: string; expiresAt: number }
  | { state: 'refused'; refusal: Refusal }
  | { state: 'unreachable' };

export function githubRepoRecord(body: unknown): HostRepoRecord | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const r = body as { id?: unknown; name?: unknown; owner?: { id?: unknown; login?: unknown } };
  if (typeof r.id !== 'number' || typeof r.name !== 'string') return undefined;
  if (typeof r.owner?.id !== 'number' || typeof r.owner.login !== 'string') return undefined;
  return { host: 'github', id: r.id, owner: r.owner.login, ownerId: r.owner.id, name: r.name };
}

function isAdmin(body: unknown): boolean {
  const permissions = (body as { permissions?: Record<string, unknown> } | undefined)?.permissions;
  return permissions?.admin === true || permissions?.maintain === true;
}

function repoIdOf(repo: HostRepo): number | undefined {
  const id = (repo as { id?: unknown }).id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined;
}

function repoAddress(repo: HostRepo): string {
  const id = repoIdOf(repo);
  return id === undefined ? repoPath(repo) : `/repositories/${id}`;
}

export function isRateLimited(status: number, headers: Headers, text: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return (
    headers.get('x-ratelimit-remaining') === '0' ||
    headers.get('retry-after') !== null ||
    /rate limit/i.test(text)
  );
}

function repoKey(repo: HostRepo): string {
  const id = repoIdOf(repo);
  if (id !== undefined) return `#${id}`;
  return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
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
  const now = deps.now ?? Date.now;
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const minting = new Map<string, Promise<Minted>>();
  const installationOfRepoId = new Map<number, number>();

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

  async function call(
    path: string,
    token: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Answer> {
    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${config.apiUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...apiHeaders(token),
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      text = await response.text();
    } catch {
      return { status: 'unreachable' };
    }
    if (response.status >= 500 || isRateLimited(response.status, response.headers, text)) {
      return { status: 'unreachable' };
    }
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  function appJwt(app: GitHubAppAuth): string | undefined {
    try {
      return app.jwt();
    } catch {
      return undefined;
    }
  }

  async function mint(app: GitHubAppAuth, repo: HostRepo): Promise<Minted> {
    const jwt = appJwt(app);
    if (jwt === undefined) return { state: 'refused', refusal: 'token' };
    const repoId = repoIdOf(repo);
    const installation = await call(`${repoAddress(repo)}/installation`, jwt);
    if (installation.status === 'unreachable') return { state: 'unreachable' };
    if (installation.status === 404) return { state: 'refused', refusal: 'removed' };
    const id = (installation.body as { id?: unknown } | undefined)?.id;
    if (installation.status !== 200 || typeof id !== 'number') {
      return { state: 'refused', refusal: 'token' };
    }
    const minted = await call(`/app/installations/${id}/access_tokens`, jwt, {
      method: 'POST',
      body: repoId === undefined ? { repositories: [repo.name] } : { repository_ids: [repoId] },
    });
    if (minted.status === 'unreachable') return { state: 'unreachable' };
    if (minted.status === 404 || minted.status === 422) {
      return { state: 'refused', refusal: 'removed' };
    }
    const body = minted.body as { token?: unknown; expires_at?: unknown } | undefined;
    const expiresAt = typeof body?.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
    if (minted.status !== 201 || typeof body?.token !== 'string' || !Number.isFinite(expiresAt)) {
      return { state: 'refused', refusal: 'token' };
    }
    return { state: 'ok', token: body.token, expiresAt };
  }

  async function repoToken(app: GitHubAppAuth, repo: HostRepo): Promise<Minted> {
    const key = repoKey(repo);
    const cached = tokens.get(key);
    if (cached !== undefined && cached.expiresAt - now() > RENEW_BEFORE_EXPIRY_MS) {
      return { state: 'ok', ...cached };
    }
    const running = minting.get(key);
    if (running !== undefined) return running;
    const next = mint(app, repo).then((answer) => {
      minting.delete(key);
      if (answer.state === 'ok') {
        tokens.set(key, { token: answer.token, expiresAt: answer.expiresAt });
      } else if (answer.state === 'refused') {
        tokens.delete(key);
      }
      return answer;
    });
    minting.set(key, next);
    const answer = await next;
    if (answer.state === 'unreachable' && cached !== undefined && cached.expiresAt > now()) {
      return { state: 'ok', ...cached };
    }
    return answer;
  }

  async function botToken(repo: HostRepo): Promise<Minted> {
    if (deps.app !== undefined) return repoToken(deps.app, repo);
    const token = deps.installationToken?.();
    return token === undefined
      ? { state: 'unreachable' }
      : { state: 'ok', token, expiresAt: Number.POSITIVE_INFINITY };
  }

  async function tokenForId(app: GitHubAppAuth, id: number): Promise<Minted | undefined> {
    const jwt = appJwt(app);
    if (jwt === undefined) return { state: 'refused', refusal: 'token' };
    const tryInstallation = async (installation: number): Promise<Minted | undefined> => {
      const minted = await call(`/app/installations/${installation}/access_tokens`, jwt, {
        method: 'POST',
        body: { repository_ids: [id], permissions: { metadata: 'read' } },
      });
      if (minted.status === 'unreachable') return { state: 'unreachable' };
      if (minted.status === 401) return { state: 'refused', refusal: 'token' };
      const token = (minted.body as { token?: unknown } | undefined)?.token;
      if (minted.status !== 201 || typeof token !== 'string') return undefined;
      installationOfRepoId.set(id, installation);
      return { state: 'ok', token, expiresAt: now() };
    };
    const known = installationOfRepoId.get(id);
    if (known !== undefined) {
      const answer = await tryInstallation(known);
      if (answer !== undefined) return answer;
      installationOfRepoId.delete(id);
    }
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const list = await call(`/app/installations?per_page=${PER_PAGE}&page=${page}`, jwt);
      if (list.status === 'unreachable') return { state: 'unreachable' };
      if (list.status !== 200 || !Array.isArray(list.body)) {
        return { state: 'refused', refusal: 'token' };
      }
      for (const item of list.body) {
        const installation = (item as { id?: unknown }).id;
        if (typeof installation !== 'number' || installation === known) continue;
        const answer = await tryInstallation(installation);
        if (answer !== undefined) return answer;
      }
      if (list.body.length < PER_PAGE) break;
    }
    return undefined;
  }

  async function repoById(id: number): Promise<RepoLookup> {
    let token: string;
    if (deps.app !== undefined) {
      const minted = await tokenForId(deps.app, id);
      if (minted === undefined) return { state: 'gone' };
      if (minted.state !== 'ok') return minted;
      token = minted.token;
    } else {
      const installation = deps.installationToken?.();
      if (installation === undefined) return { state: 'unreachable' };
      token = installation;
    }
    const answer = await call(`/repositories/${encodeURIComponent(String(id))}`, token);
    if (answer.status === 'unreachable') return { state: 'unreachable' };
    if (answer.status === 401) return { state: 'refused', refusal: 'token' };
    if (answer.status === 403 || answer.status === 404) return { state: 'gone' };
    const repo = answer.status === 200 ? githubRepoRecord(answer.body) : undefined;
    return repo === undefined ? { state: 'unreachable' } : { state: 'found', repo };
  }

  async function repoByName(repo: HostRepo): Promise<RepoLookup> {
    let token: string;
    if (deps.app !== undefined) {
      const minted = await repoToken(deps.app, { owner: repo.owner, name: repo.name });
      if (minted.state === 'refused') {
        return minted.refusal === 'removed' ? { state: 'gone' } : minted;
      }
      if (minted.state !== 'ok') return minted;
      token = minted.token;
    } else {
      const installation = deps.installationToken?.();
      if (installation === undefined) return { state: 'unreachable' };
      token = installation;
    }
    const answer = await call(repoPath(repo), token);
    if (answer.status === 'unreachable') return { state: 'unreachable' };
    if (answer.status === 401) return { state: 'refused', refusal: 'token' };
    if (answer.status === 403 || answer.status === 404) return { state: 'gone' };
    const found = answer.status === 200 ? githubRepoRecord(answer.body) : undefined;
    return found === undefined ? { state: 'unreachable' } : { state: 'found', repo: found };
  }

  async function health(repo: HostRepoRef): Promise<HostHealth> {
    if (deps.app !== undefined) {
      const minted = await repoToken(deps.app, repo);
      if (minted.state === 'ok') return 'ok';
      return minted.state === 'refused' ? `refused:${minted.refusal}` : 'unreachable';
    }
    const token = deps.installationToken?.();
    if (token === undefined) return 'unreachable';
    const answer = await call(repoAddress(repo), token);
    if (answer.status === 'unreachable') return 'unreachable';
    if (answer.status === 200) return 'ok';
    if (answer.status === 401) return 'refused:token';
    if (answer.status === 403 || answer.status === 404) return 'refused:removed';
    return 'unreachable';
  }

  async function pages(
    path: string,
    token: string,
    field: 'installations' | 'repositories',
  ): Promise<unknown[] | 'refused' | 'unreachable' | 'missing'> {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const answer = await call(`${path}?per_page=${PER_PAGE}&page=${page}`, token);
      if (answer.status === 'unreachable') return 'unreachable';
      if (answer.status === 401 || answer.status === 403) return 'refused';
      if (answer.status === 404) return 'missing';
      const body = answer.body as Record<string, unknown> | undefined;
      const list = body?.[field];
      if (answer.status !== 200 || !Array.isArray(list)) return 'unreachable';
      items.push(...list);
      const total = typeof body?.total_count === 'number' ? body.total_count : undefined;
      if (
        list.length === 0 ||
        (total !== undefined ? items.length >= total : list.length < PER_PAGE)
      ) {
        break;
      }
    }
    return items;
  }

  async function addableRepos(personToken: string): Promise<AddableRepos> {
    const installations = await pages('/user/installations', personToken, 'installations');
    if (installations === 'refused') return { state: 'refused', whose: 'person' };
    if (installations === 'unreachable' || installations === 'missing') {
      return { state: 'unreachable' };
    }
    const repos: AddableRepo[] = [];
    const seen = new Set<number>();
    for (const installation of installations) {
      const id = (installation as { id?: unknown }).id;
      if (typeof id !== 'number') continue;
      const list = await pages(
        `/user/installations/${id}/repositories`,
        personToken,
        'repositories',
      );
      if (list === 'missing') continue;
      if (list === 'refused') return { state: 'refused', whose: 'person' };
      if (list === 'unreachable') return { state: 'unreachable' };
      for (const item of list) {
        const record = githubRepoRecord(item);
        if (record === undefined || !isAdmin(item) || seen.has(record.id)) continue;
        seen.add(record.id);
        repos.push(record);
      }
    }
    return { state: 'listed', repos };
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

  async function access(token: string, repo: HostRepoRef): Promise<RepoAccess> {
    const { status, body } = await json(`${config.apiUrl}${repoAddress(repo)}`, {
      headers: apiHeaders(token),
    });
    if (status !== 200 || typeof body !== 'object' || body === null) return 'none';
    const permissions = (body as { permissions?: Record<string, unknown> }).permissions;
    if (permissions?.admin === true || permissions?.maintain === true) return 'admin';
    return permissions?.push === true ? 'write' : 'none';
  }

  async function accessByBot(login: string, repo: HostRepoRef): Promise<BotAccess> {
    const minted = await botToken(repo);
    if (minted.state === 'unreachable') return 'unreachable';
    if (minted.state === 'refused') return `refused:${minted.refusal}`;
    const token = minted.token;
    const url = `${config.apiUrl}${repoAddress(repo)}/collaborators/${encodeURIComponent(login)}/permission`;
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, { headers: apiHeaders(token) });
      text = await response.text();
    } catch {
      return 'unreachable';
    }
    if (isRateLimited(response.status, response.headers, text)) return 'unreachable';
    if (response.status === 404) return 'none';
    if (response.status === 401) {
      tokens.delete(repoKey(repo));
      return 'refused:token';
    }
    if (response.status === 403) return 'refused:not-admin';
    if (response.status !== 200) return 'unreachable';
    let body: { permission?: unknown; role_name?: unknown } | undefined;
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      body = undefined;
    }
    const role = typeof body?.role_name === 'string' ? body.role_name : body?.permission;
    if (typeof role !== 'string' || !WRITE_ROLES.has(role)) return 'none';
    return ADMIN_ROLES.has(role) ? 'admin' : 'write';
  }

  return {
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
    addableRepos,
    repoById,
    repoByName,
    health,
    tokenFor: async (repo) => {
      if (deps.app !== undefined) {
        const minted = await repoToken(deps.app, repo);
        return minted.state === 'ok' ? minted.token : undefined;
      }
      return config.repo !== undefined && sameRepo(repo, config.repo)
        ? deps.installationToken?.()
        : undefined;
    },
    selfCheck: async () => ({ ok: true }),
  };
}
