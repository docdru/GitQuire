import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PinoLogger } from '../logger.ts';
import type { AccessVerdict } from './agent-access.ts';
import { AGENTS_PAGE_PATH, createAgentPages } from './agent-pages.ts';
import type { AgentTokenRecord, AgentTokenStore } from './agent-tokens.ts';
import { isAppIconPath } from './app-icons.ts';
import type { GitHubAuthConfig } from './github-auth-config.ts';
import { createGitHubDoorHost } from './host/github.ts';
import { callbackPath, hostNames, signInPath } from './host/names.ts';
import type { DoorHost } from './host/types.ts';
import {
  bearerToken,
  escapeHtml,
  pathOf,
  redirect,
  sendHtml,
  sendJson,
  wantsHtml,
} from './http-util.ts';
import { isInternalRequest } from './internal-request.ts';
import { createOAuthServer } from './oauth-server.ts';
import {
  bindRequestPrincipal,
  type GitQuirePrincipal,
  principalIdForUser,
  sanitizeDisplayName,
} from './principal-directory.ts';
import { createRequestPerson } from './request-person.ts';
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

export interface SessionUser {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
  repoAdmin?: boolean;
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
  host?: DoorHost;
}

export interface AccessGate {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => boolean;
  admitUpgrade: (req: IncomingMessage, socket: Duplex) => boolean;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  isAdminRequest: (req: IncomingMessage) => boolean;
  agentOwner?: (req: IncomingMessage) => SessionUser | undefined;
  routeUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
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
  if (!/^[\x21-\x7e]+$/.test(raw)) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/auth/') && raw !== AGENTS_PAGE_PATH) return '/';
  return raw;
}

export function noreplyEmail(user: Pick<SessionUser, 'id' | 'login'>): string {
  return hostNames().noreplyEmail(user);
}

export function principalFromUser(user: SessionUser): GitQuirePrincipal {
  return {
    id: principalIdForUser(user.id),
    login: user.login,
    name: sanitizeDisplayName(user.name, user.login),
    email: noreplyEmail(user),
  };
}

export function isPublicAsset(path: string, method: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return isAppIconPath(path);
}

const IN_APP_AGENT_PREFIXES = ['/api/acp/', '/api/agent-integrations/', '/collab/thread'];

export function isInAppAgentPath(path: string): boolean {
  return IN_APP_AGENT_PREFIXES.some(
    (prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix),
  );
}

const ADMIN_ONLY_WRITE_PREFIXES = ['/api/generated-index/'];

function isAdminOnlyApi(path: string, method: string | undefined): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return ADMIN_ONLY_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function refuseForPerson(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  user: SessionUser,
  admin: boolean,
  now: () => number,
): boolean {
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
  if (isInAppAgentPath(path)) {
    sendJson(res, 403, { error: 'in-app-agents-removed' });
    return true;
  }
  if (isAdminOnlyApi(path, req.method) && !admin) {
    sendJson(res, 403, { error: 'admin-only' });
    return true;
  }
  if (path.startsWith('/api/local-op/')) {
    const readOnlyStatus = path === '/api/local-op/auth/status' && req.method === 'GET';
    if (!readOnlyStatus && !admin) {
      sendJson(res, 403, { error: 'admin-only' });
      return true;
    }
  }
  return false;
}

interface MeFeatures {
  aiChat: boolean;
  agentToken: boolean;
  connector: boolean;
  canUseTokens: boolean;
  canConnect: boolean;
}

export function meBody(
  user: SessionUser,
  details: {
    admin: boolean;
    adminLogins: ReadonlySet<string>;
    repo: string | undefined;
    features: MeFeatures;
  },
): Record<string, unknown> {
  return {
    ...user,
    principalId: principalIdForUser(user.id),
    email: noreplyEmail(user),
    admin: details.admin,
    admins: {
      logins: [...details.adminLogins].sort(),
      repo: details.repo ?? null,
    },
    features: details.features,
  };
}

export function createAccessGate(config: GitHubAuthConfig, deps: AccessGateDeps): AccessGate {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const randomState = deps.randomState ?? (() => randomBytes(24).toString('base64url'));
  const host =
    deps.host ??
    createGitHubDoorHost(
      {
        webUrl: config.githubWebUrl,
        apiUrl: config.githubApiUrl,
        repo: config.repo,
      },
      { fetch: doFetch },
    );
  const secure = config.externalUrl.protocol === 'https:';
  const names = hostNames();
  const loginPath = signInPath(names);
  const returnPath = callbackPath(names);
  const label = names.label;
  const callbackUrl = new URL(returnPath, config.externalUrl).toString();
  const repoLabel =
    config.repo === undefined ? undefined : `${config.repo.owner}/${config.repo.name}`;

  const cookie = (name: string, value: string, maxAgeSeconds: number): string =>
    serializeCookie(name, value, { maxAgeSeconds, secure });
  const clearCookie = (name: string): string => cookie(name, '', 0);

  function cookieUser(req: IncomingMessage): SessionUser | undefined {
    const decoded = decodeSigned(config.sessionSecret, readCookie(req, SESSION_COOKIE));
    if (!isSessionPayload(decoded)) return undefined;
    if (decoded.exp * 1000 <= now()) return undefined;
    return {
      id: decoded.id,
      login: decoded.login,
      name: decoded.name,
      avatarUrl: decoded.avatarUrl,
      ...(decoded.repoAdmin === true ? { repoAdmin: true } : {}),
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
    const owner = person.agentOwner(req);
    if (owner !== undefined) {
      bindRequestPrincipal(req, principalFromUser(owner));
      return true;
    }
    return sharedMcpTokenAccepted(bearerToken(req));
  }

  const person = createRequestPerson({
    behindFrontDoor: false,
    cookieUser,
    agentTokenOwner: (req) => agentTokenRecord(bearerToken(req))?.owner,
    isAdmin,
  });
  const { sessionUser, isAdminRequest, agentOwner } = person;

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
    return config.admins.has(user.login.toLowerCase()) || user.repoAdmin === true;
  }

  function startLogin(req: IncomingMessage, res: ServerResponse, search: string): void {
    const next = safeNextPath(new URLSearchParams(search).get('next'));
    const state = randomState();
    const statePayload: StatePayload = {
      state,
      next,
      exp: Math.floor(now() / 1000) + STATE_MAX_AGE_SECONDS,
    };
    const authorize = host.authorizeUrl({
      clientId: config.clientId,
      redirectUri: callbackUrl,
      state,
    });
    redirect(res, authorize, {
      'Set-Cookie': cookie(
        STATE_COOKIE,
        encodeSigned(config.sessionSecret, statePayload),
        STATE_MAX_AGE_SECONDS,
      ),
    });
    deps.log.info({ next, method: req.method }, `[gitquire-auth] redirecting to ${label} sign-in`);
  }

  async function repoAccess(token: string): Promise<{ write: boolean; admin: boolean }> {
    if (config.repo === undefined) return { write: false, admin: false };
    const level = await host.access(token, config.repo);
    return { write: level !== 'none', admin: level === 'admin' };
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
    const tryAgain = `<p><a href="${loginPath}">Sign in with ${label}</a></p>`;

    if (params.get('error') !== null) {
      sendHtml(
        res,
        401,
        'Sign-in cancelled',
        `<p>${label} did not complete the sign-in.</p>${tryAgain}`,
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

    const token = await host.exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: callbackUrl,
    });
    const user = token === undefined ? undefined : await host.person(token);
    if (token === undefined || user === undefined) {
      deps.log.warn({ gotToken: token !== undefined }, `[gitquire-auth] ${label} sign-in failed`);
      sendHtml(
        res,
        502,
        'Sign-in failed',
        `<p>${label} did not confirm the sign-in.</p>${tryAgain}`,
        { 'Set-Cookie': clearState },
      );
      return;
    }

    const access = await repoAccess(token);
    const allowed = config.allowedUsers.has(user.login.toLowerCase()) || access.write;
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
        `<p>The ${label} account <strong>@${escapeHtml(user.login)}</strong> ${reason}. Ask the owner for access, then try again.</p>${tryAgain}`,
        { 'Set-Cookie': clearState },
      );
      return;
    }

    const session: SessionPayload = {
      v: 1,
      ...user,
      ...(access.admin ? { repoAdmin: true } : {}),
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
    if (path === loginPath) {
      startLogin(req, res, search);
      return;
    }
    if (path === returnPath) {
      completeLogin(req, res, search).catch((err: unknown) => {
        deps.log.error({ err }, '[gitquire-auth] sign-in callback failed');
        if (!res.headersSent) {
          sendHtml(
            res,
            502,
            'Sign-in failed',
            `<p>Could not reach ${label}. Try again in a moment.</p>`,
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
          `<p>You are signed out of GitQuire.</p><p><a href="${loginPath}">Sign in with ${label}</a></p>`,
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
      sendJson(
        res,
        200,
        meBody(user, {
          admin: isAdmin(user),
          adminLogins: config.admins,
          repo: repoLabel,
          features: {
            aiChat: config.aiChat,
            ...agentAccess(user),
            canUseTokens: agentPages !== undefined,
            canConnect: oauth !== undefined,
          },
        }),
      );
      return;
    }
    if (agentPages?.handle(req, res, path) === true) return;
    sendJson(res, 404, { error: 'not-found' });
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const { path, search } = pathOf(req);
    const raw = (req.url ?? '/').split('?')[0] ?? '/';
    if ((path === '/healthz' || path === '/readyz') && raw === path) return false;
    if (isPublicAsset(path, req.method)) return false;
    if (oauth?.handle(req, res, path, search) === true) return true;
    if (path.startsWith('/api/') && isInternalRequest(req)) return false;
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
        redirect(res, `${loginPath}?next=${encodeURIComponent(path + search)}`);
      } else {
        sendJson(res, 401, { error: 'not-signed-in', signIn: loginPath });
      }
      return true;
    }
    return refuseForPerson(req, res, path, user, isAdmin(user), now);
  }

  function admitUpgrade(req: IncomingMessage, socket: Duplex): boolean {
    const { path } = pathOf(req);
    const raw = (req.url ?? '/').split('?')[0] ?? '/';
    if (!path.startsWith('/collab') && !raw.startsWith('/collab')) return true;
    if (raw !== path) {
      deps.log.warn({ path }, '[gitquire-auth] refused websocket upgrade with an unusual path');
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return false;
    }
    if (isInAppAgentPath(path)) {
      deps.log.warn({ path }, '[gitquire-auth] refused in-app agent session');
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return false;
    }
    if (sessionUser(req) !== undefined) return true;
    if (path === '/collab/keepalive' && admitAgent(req)) return true;
    deps.log.warn({ path }, '[gitquire-auth] refused unauthenticated websocket upgrade');
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return false;
  }

  return { handleRequest, admitUpgrade, sessionUser, isAdminRequest, agentOwner };
}
