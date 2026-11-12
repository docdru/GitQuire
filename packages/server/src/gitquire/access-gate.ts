import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PinoLogger } from '../logger.ts';
import type { AccessVerdict } from './agent-access.ts';
import { AGENTS_PAGE_PATH, createAgentPages } from './agent-pages.ts';
import type { AgentTokenRecord, AgentTokenStore } from './agent-tokens.ts';
import type { GitHubAuthConfig } from './github-auth-config.ts';
import {
  bearerToken,
  escapeHtml,
  pathOf,
  redirect,
  sendHtml,
  sendJson,
  wantsHtml,
} from './http-util.ts';
import { createOAuthServer } from './oauth-server.ts';
import {
  bindRequestPrincipal,
  type GitQuirePrincipal,
  principalIdForGitHubUser,
  sanitizeDisplayName,
} from './principal-directory.ts';
import {
  decodeSigned,
  encodeSigned,
  readCookie,
  safeEqual,
  serializeCookie,
} from './signed-cookie.ts';

export const SESSION_COOKIE = 'gq_session';
export const STATE_COOKIE = 'gq_oauth_state';
const STATE_MAX_AGE_SECONDS = 600;
const GITHUB_API_VERSION = '2022-11-28';

export interface SessionUser {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
}

interface SessionPayload extends SessionUser {
  v: 1;
  exp: number;
}

interface StatePayload {
  state: string;
  next: string;
  exp: number;
}

export type GateLogger = Pick<PinoLogger, 'info' | 'warn' | 'error'>;

export interface AccessGateDeps {
  log: GateLogger;
  fetch?: typeof fetch;
  now?: () => number;
  randomState?: () => string;
  agentTokens?: AgentTokenStore;
  checkAccess?: (login: string) => Promise<AccessVerdict>;
}

export interface AccessGate {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => boolean;
  admitUpgrade: (req: IncomingMessage, socket: Duplex) => boolean;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.id === 'number' &&
    typeof v.login === 'string' &&
    typeof v.name === 'string' &&
    typeof v.avatarUrl === 'string' &&
    typeof v.exp === 'number'
  );
}

function isStatePayload(value: unknown): value is StatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.state === 'string' && typeof v.next === 'string' && typeof v.exp === 'number';
}

export function safeNextPath(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/auth/') && raw !== AGENTS_PAGE_PATH) return '/';
  return raw;
}

export function noreplyEmail(user: Pick<SessionUser, 'id' | 'login'>): string {
  return `${user.id}+${user.login}@users.noreply.github.com`;
}

export function principalFromUser(user: SessionUser): GitQuirePrincipal {
  return {
    id: principalIdForGitHubUser(user.id),
    login: user.login,
    name: sanitizeDisplayName(user.name, user.login),
    email: noreplyEmail(user),
  };
}

const PUBLIC_ASSET_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg']);
const PUBLIC_ICON_RE = /^\/icons\/[a-z0-9-]+\.(?:png|svg)$/;

export function isPublicAsset(path: string, method: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return PUBLIC_ASSET_PATHS.has(path) || PUBLIC_ICON_RE.test(path);
}

export function createAccessGate(config: GitHubAuthConfig, deps: AccessGateDeps): AccessGate {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const randomState = deps.randomState ?? (() => randomBytes(24).toString('base64url'));
  const secure = config.externalUrl.protocol === 'https:';
  const callbackUrl = new URL('/auth/github/callback', config.externalUrl).toString();
  const repoLabel =
    config.repo === undefined ? undefined : `${config.repo.owner}/${config.repo.name}`;

  const cookie = (name: string, value: string, maxAgeSeconds: number): string =>
    serializeCookie(name, value, { maxAgeSeconds, secure });
  const clearCookie = (name: string): string => cookie(name, '', 0);

  function sessionUser(req: IncomingMessage): SessionUser | undefined {
    const decoded = decodeSigned(config.sessionSecret, readCookie(req, SESSION_COOKIE));
    if (!isSessionPayload(decoded)) return undefined;
    if (decoded.exp * 1000 <= now()) return undefined;
    return {
      id: decoded.id,
      login: decoded.login,
      name: decoded.name,
      avatarUrl: decoded.avatarUrl,
    };
  }

  function sharedMcpTokenAccepted(token: string | undefined): boolean {
    if (config.mcpToken === undefined || token === undefined) return false;
    return safeEqual(token, config.mcpToken);
  }

  function agentTokenRecord(token: string | undefined): AgentTokenRecord | undefined {
    if (token === undefined || deps.agentTokens === undefined) return undefined;
    return deps.agentTokens.verify(token);
  }

  function admitAgent(req: IncomingMessage): boolean {
    const token = bearerToken(req);
    const record = agentTokenRecord(token);
    if (record !== undefined) {
      bindRequestPrincipal(req, principalFromUser(record.owner));
      return true;
    }
    return sharedMcpTokenAccepted(token);
  }

  function agentAccess(user: SessionUser): { agentToken: boolean; connector: boolean } {
    const records = deps.agentTokens?.list(user.id) ?? [];
    return {
      agentToken: records.some((record) => record.kind === 'personal'),
      connector: records.some((record) => record.kind === 'connector'),
    };
  }

  const agentPages =
    deps.agentTokens === undefined
      ? undefined
      : createAgentPages({
          config,
          store: deps.agentTokens,
          log: deps.log,
          sessionUser,
          connectorsEnabled: config.mcpConnectors,
          now,
        });

  const oauth =
    deps.agentTokens === undefined || !config.mcpConnectors
      ? undefined
      : createOAuthServer({
          externalUrl: config.externalUrl,
          secret: config.sessionSecret,
          store: deps.agentTokens,
          log: deps.log,
          sessionUser,
          checkAccess: deps.checkAccess,
          fetch: deps.fetch,
          now,
        });

  function isAdmin(user: SessionUser): boolean {
    return config.admins.has(user.login.toLowerCase());
  }

  function startLogin(req: IncomingMessage, res: ServerResponse, search: string): void {
    const next = safeNextPath(new URLSearchParams(search).get('next'));
    const state = randomState();
    const statePayload: StatePayload = {
      state,
      next,
      exp: Math.floor(now() / 1000) + STATE_MAX_AGE_SECONDS,
    };
    const authorize = new URL(`${config.githubWebUrl}/login/oauth/authorize`);
    authorize.searchParams.set('client_id', config.clientId);
    authorize.searchParams.set('redirect_uri', callbackUrl);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('allow_signup', 'false');
    redirect(res, authorize.toString(), {
      'Set-Cookie': cookie(
        STATE_COOKIE,
        encodeSigned(config.sessionSecret, statePayload),
        STATE_MAX_AGE_SECONDS,
      ),
    });
    deps.log.info({ next, method: req.method }, '[gitquire-auth] redirecting to GitHub sign-in');
  }

  async function githubJson(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; body: unknown }> {
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

  async function exchangeCode(code: string): Promise<string | undefined> {
    const { body } = await githubJson(`${config.githubWebUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'GitQuire',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    });
    const token = (body as { access_token?: unknown } | undefined)?.access_token;
    return typeof token === 'string' && token !== '' ? token : undefined;
  }

  function apiHeaders(token: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'GitQuire',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
  }

  async function fetchUser(token: string): Promise<SessionUser | undefined> {
    const { status, body } = await githubJson(`${config.githubApiUrl}/user`, {
      headers: apiHeaders(token),
    });
    if (status !== 200 || typeof body !== 'object' || body === null) return undefined;
    const u = body as Record<string, unknown>;
    if (typeof u.id !== 'number' || typeof u.login !== 'string') return undefined;
    const name = typeof u.name === 'string' && u.name.trim() !== '' ? u.name : u.login;
    const avatarUrl = typeof u.avatar_url === 'string' ? u.avatar_url : '';
    return { id: u.id, login: u.login, name, avatarUrl };
  }

  async function hasRepoWriteAccess(token: string): Promise<boolean> {
    if (config.repo === undefined) return false;
    const owner = encodeURIComponent(config.repo.owner);
    const name = encodeURIComponent(config.repo.name);
    const { status, body } = await githubJson(`${config.githubApiUrl}/repos/${owner}/${name}`, {
      headers: apiHeaders(token),
    });
    if (status !== 200 || typeof body !== 'object' || body === null) return false;
    const permissions = (body as { permissions?: Record<string, unknown> }).permissions;
    return (
      permissions?.push === true || permissions?.admin === true || permissions?.maintain === true
    );
  }

  async function completeLogin(
    req: IncomingMessage,
    res: ServerResponse,
    search: string,
  ): Promise<void> {
    const params = new URLSearchParams(search);
    const code = params.get('code');
    const state = params.get('state');
    const stored = decodeSigned(config.sessionSecret, readCookie(req, STATE_COOKIE));
    const clearState = clearCookie(STATE_COOKIE);
    const tryAgain = '<p><a href="/auth/github/login">Sign in with GitHub</a></p>';

    if (params.get('error') !== null) {
      sendHtml(
        res,
        401,
        'Sign-in cancelled',
        `<p>GitHub did not complete the sign-in.</p>${tryAgain}`,
        { 'Set-Cookie': clearState },
      );
      return;
    }
    if (
      code === null ||
      state === null ||
      !isStatePayload(stored) ||
      stored.exp * 1000 <= now() ||
      !safeEqual(state, stored.state)
    ) {
      sendHtml(
        res,
        400,
        'Sign-in expired',
        `<p>The sign-in link expired or was opened in another browser.</p>${tryAgain}`,
        { 'Set-Cookie': clearState },
      );
      return;
    }

    const token = await exchangeCode(code);
    const user = token === undefined ? undefined : await fetchUser(token);
    if (token === undefined || user === undefined) {
      deps.log.warn({ gotToken: token !== undefined }, '[gitquire-auth] GitHub sign-in failed');
      sendHtml(
        res,
        502,
        'Sign-in failed',
        `<p>GitHub did not confirm the sign-in.</p>${tryAgain}`,
        { 'Set-Cookie': clearState },
      );
      return;
    }

    const allowed =
      config.allowedUsers.has(user.login.toLowerCase()) || (await hasRepoWriteAccess(token));
    if (!allowed) {
      deps.log.warn({ login: user.login }, '[gitquire-auth] sign-in refused: no access');
      const reason =
        repoLabel === undefined
          ? 'is not on the list of allowed users'
          : `does not have write access to <code>${escapeHtml(repoLabel)}</code>`;
      sendHtml(
        res,
        403,
        'No access',
        `<p>The GitHub account <strong>@${escapeHtml(user.login)}</strong> ${reason}. Ask the owner for access, then try again.</p>${tryAgain}`,
        { 'Set-Cookie': clearState },
      );
      return;
    }

    const session: SessionPayload = {
      v: 1,
      ...user,
      exp: Math.floor(now() / 1000) + config.sessionMaxAgeSeconds,
    };
    deps.log.info({ login: user.login }, '[gitquire-auth] signed in');
    redirect(res, stored.next, {
      'Set-Cookie': [
        clearState,
        cookie(
          SESSION_COOKIE,
          encodeSigned(config.sessionSecret, session),
          config.sessionMaxAgeSeconds,
        ),
      ],
    });
  }

  function handleAuthRoute(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    search: string,
  ): void {
    if (path === '/auth/github/login') {
      startLogin(req, res, search);
      return;
    }
    if (path === '/auth/github/callback') {
      completeLogin(req, res, search).catch((err: unknown) => {
        deps.log.error({ err }, '[gitquire-auth] sign-in callback failed');
        if (!res.headersSent) {
          sendHtml(
            res,
            502,
            'Sign-in failed',
            '<p>Could not reach GitHub. Try again in a moment.</p>',
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      return;
    }
    if (path === '/auth/logout') {
      if (req.method === 'POST') {
        sendHtml(
          res,
          200,
          'Signed out',
          '<p>You are signed out of GitQuire.</p><p><a href="/auth/github/login">Sign in with GitHub</a></p>',
          { 'Set-Cookie': clearCookie(SESSION_COOKIE) },
        );
        return;
      }
      const user = sessionUser(req);
      const who = user === undefined ? '' : ` as <strong>@${escapeHtml(user.login)}</strong>`;
      sendHtml(
        res,
        200,
        'Sign out',
        `<p>You are signed in${who}.</p>${agentPages === undefined ? '' : `<p><a href="${AGENTS_PAGE_PATH}">AI agent access</a></p>`}<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>`,
      );
      return;
    }
    if (path === '/auth/me') {
      const user = sessionUser(req);
      if (user === undefined) {
        sendJson(res, 401, { error: 'not-signed-in' });
        return;
      }
      sendJson(res, 200, {
        ...user,
        email: noreplyEmail(user),
        admin: isAdmin(user),
        features: { askAi: config.askAi, ...agentAccess(user) },
      });
      return;
    }
    if (agentPages?.handle(req, res, path) === true) return;
    sendJson(res, 404, { error: 'not-found' });
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const { path, search } = pathOf(req);
    if (path === '/healthz' || path === '/readyz') return false;
    if (isPublicAsset(path, req.method)) return false;
    if (oauth?.handle(req, res, path, search) === true) return true;
    if (path.startsWith('/auth/')) {
      handleAuthRoute(req, res, path, search);
      return true;
    }
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      if (admitAgent(req)) return false;
      sendJson(
        res,
        401,
        { error: 'mcp-token-required', tokens: AGENTS_PAGE_PATH },
        { 'WWW-Authenticate': oauth?.wwwAuthenticate() ?? 'Bearer' },
      );
      return true;
    }
    const user = sessionUser(req);
    if (user === undefined) {
      if (wantsHtml(req)) {
        redirect(res, `/auth/github/login?next=${encodeURIComponent(path + search)}`);
      } else {
        sendJson(res, 401, { error: 'not-signed-in', signIn: '/auth/github/login' });
      }
      return true;
    }
    if (path === '/api/principal' && req.method === 'GET') {
      const principal = principalFromUser(user);
      sendJson(res, 200, {
        id: principal.id,
        display_name: principal.name,
        display_email: principal.email,
        source: 'git-config',
        created_at: new Date(now()).toISOString(),
      });
      return true;
    }
    if (path.startsWith('/api/local-op/')) {
      const readOnlyStatus = path === '/api/local-op/auth/status' && req.method === 'GET';
      if (!readOnlyStatus && !isAdmin(user)) {
        sendJson(res, 403, { error: 'admin-only' });
        return true;
      }
    }
    return false;
  }

  function admitUpgrade(req: IncomingMessage, socket: Duplex): boolean {
    const { path } = pathOf(req);
    if (!path.startsWith('/collab')) return true;
    if (sessionUser(req) !== undefined) return true;
    if (path === '/collab/keepalive' && admitAgent(req)) return true;
    deps.log.warn({ path }, '[gitquire-auth] refused unauthenticated websocket upgrade');
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return false;
  }

  return { handleRequest, admitUpgrade, sessionUser };
}
