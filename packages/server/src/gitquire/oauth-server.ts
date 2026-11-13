import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GateLogger, SessionUser } from './access-gate.ts';
import type { AccessVerdict } from './agent-access.ts';
import { type AgentTokenStore, cleanLabel, type IssuedConnectorTokens } from './agent-tokens.ts';
import { escapeHtml, isSameOriginRequest, readForm, redirect, sendHtml } from './http-util.ts';
import { decodeSigned, encodeSigned, safeEqual } from './signed-cookie.ts';

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';
const AUTHORIZE_PATH = '/oauth/authorize';
const TOKEN_PATH = '/oauth/token';
const REGISTER_PATH = '/oauth/register';
const CODE_SECONDS = 120;
const CONSENT_SECONDS = 600;
const CLIENT_CACHE_MS = 10 * 60 * 1000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_BODY_BYTES = 16 * 1024;
const TOKEN_AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'] as const;

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  confidential?: boolean;
}

export interface OAuthServerDeps {
  externalUrl: URL;
  secret: string;
  store: AgentTokenStore;
  log: GateLogger;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  checkAccess?: (login: string) => Promise<AccessVerdict>;
  fetch?: typeof fetch;
  now?: () => number;
  randomId?: () => string;
}

export interface OAuthServer {
  handle: (req: IncomingMessage, res: ServerResponse, path: string, search: string) => boolean;
  wwwAuthenticate: () => string;
}

interface CodePayload {
  c: string;
  r: string;
  ch: string;
  u: SessionUser;
  exp: number;
  j: string;
}

interface RegisteredClientPayload {
  r: string[];
  n: string;
  a?: 1;
}

class OAuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendOAuthJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(value));
}

export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash !== '' || url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  );
}

export function isMetadataDocumentClientId(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.pathname === '/' || url.hash !== '') return false;
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname;
  return !/^[\d.]+$/.test(host) && !host.startsWith('[') && host !== 'localhost';
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function cleanClientName(raw: unknown, fallback: string): string {
  return cleanLabel(raw, fallback).slice(0, 60);
}

function redirectUrisFrom(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECT_URIS) {
    throw new OAuthError(400, 'invalid_redirect_uri', 'Give one to ten redirect URIs.');
  }
  const uris = value.filter((uri): uri is string => typeof uri === 'string');
  if (uris.length !== value.length || !uris.every(isAllowedRedirectUri)) {
    throw new OAuthError(
      400,
      'invalid_redirect_uri',
      'Redirect URIs must use https, or http on localhost.',
    );
  }
  return uris;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new OAuthError(413, 'invalid_request', 'Request too large.');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    const parsed = parseJsonObject(text === '' ? '{}' : text);
    if (parsed === undefined) {
      throw new OAuthError(400, 'invalid_request', 'Body must be a JSON object.');
    }
    return parsed;
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function stringParam(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    throw new OAuthError(401, 'invalid_client', 'The client credentials are malformed.');
  }
}

export function basicClientCredentials(
  header: string | undefined,
): { id: string; secret: string } | undefined {
  if (header === undefined || !/^basic /i.test(header)) return undefined;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) {
    throw new OAuthError(401, 'invalid_client', 'The client credentials are malformed.');
  }
  return {
    id: decodeFormComponent(decoded.slice(0, colon)),
    secret: decodeFormComponent(decoded.slice(colon + 1)),
  };
}

export function createOAuthServer(deps: OAuthServerDeps): OAuthServer {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => randomBytes(16).toString('base64url'));
  const issuer = deps.externalUrl.origin;
  const resource = new URL('/mcp', deps.externalUrl).toString();
  const clientSecret = `${deps.secret}:oauth-client`;
  const codeSecret = `${deps.secret}:oauth-code`;
  const consentSecret = `${deps.secret}:oauth-consent`;
  const usedCodes = new Map<string, number>();
  const clientCache = new Map<string, { client: OAuthClient; until: number }>();

  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'GitQuire',
  };
  const authorizationServer = {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    registration_endpoint: `${issuer}${REGISTER_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
    client_id_metadata_document_supported: true,
    scopes_supported: ['wiki'],
  };

  function nowSeconds(): number {
    return Math.floor(now() / 1000);
  }

  function registeredClientSecret(clientId: string): string {
    const mac = createHmac('sha256', clientSecret).update(`secret:${clientId}`);
    return `gqs_${mac.digest('base64url')}`;
  }

  async function fetchClientMetadata(clientId: string): Promise<OAuthClient> {
    const cached = clientCache.get(clientId);
    if (cached !== undefined && cached.until > now()) return cached.client;
    let response: Response;
    try {
      response = await doFetch(clientId, {
        headers: { Accept: 'application/json', 'User-Agent': 'GitQuire' },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new OAuthError(400, 'invalid_client', 'Could not fetch the client metadata.');
    }
    const text = await response.text();
    if (response.status !== 200 || text.length > MAX_METADATA_BYTES) {
      throw new OAuthError(400, 'invalid_client', 'Could not fetch the client metadata.');
    }
    const doc = parseJsonObject(text);
    if (doc === undefined) {
      throw new OAuthError(400, 'invalid_client', 'The client metadata is not JSON.');
    }
    if (doc.client_id !== clientId) {
      throw new OAuthError(400, 'invalid_client', 'The client metadata names another client.');
    }
    const client: OAuthClient = {
      clientId,
      name: cleanClientName(doc.client_name, new URL(clientId).hostname),
      redirectUris: redirectUrisFrom(doc.redirect_uris),
    };
    clientCache.set(clientId, { client, until: now() + CLIENT_CACHE_MS });
    return client;
  }

  async function resolveClient(clientId: string | undefined): Promise<OAuthClient> {
    if (clientId === undefined) {
      throw new OAuthError(400, 'invalid_client', 'client_id is required.');
    }
    if (isMetadataDocumentClientId(clientId)) return fetchClientMetadata(clientId);
    if (!clientId.startsWith('gqc_')) {
      throw new OAuthError(400, 'invalid_client', 'Unknown client.');
    }
    const decoded = decodeSigned(clientSecret, clientId.slice(4)) as
      | Partial<RegisteredClientPayload>
      | undefined;
    if (decoded === undefined || !Array.isArray(decoded.r) || typeof decoded.n !== 'string') {
      throw new OAuthError(400, 'invalid_client', 'Unknown client.');
    }
    return {
      clientId,
      name: decoded.n,
      redirectUris: redirectUrisFrom(decoded.r),
      confidential: decoded.a === 1,
    };
  }

  async function authenticateClient(clientId: string, presentedSecret: string | undefined) {
    const client = await resolveClient(clientId);
    if (client.confidential !== true) return client;
    if (
      presentedSecret === undefined ||
      !safeEqual(presentedSecret, registeredClientSecret(clientId))
    ) {
      throw new OAuthError(401, 'invalid_client', 'The client secret is missing or wrong.');
    }
    return client;
  }

  async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const redirectUris = redirectUrisFrom(body.redirect_uris);
    const authMethod = body.token_endpoint_auth_method ?? 'none';
    if (!TOKEN_AUTH_METHODS.some((method) => method === authMethod)) {
      throw new OAuthError(
        400,
        'invalid_client_metadata',
        'token_endpoint_auth_method must be none, client_secret_basic or client_secret_post.',
      );
    }
    const confidential = authMethod !== 'none';
    const name = cleanClientName(body.client_name, new URL(redirectUris[0] ?? issuer).hostname);
    const payload: RegisteredClientPayload = confidential
      ? { r: redirectUris, n: name, a: 1 }
      : { r: redirectUris, n: name };
    const clientId = `gqc_${encodeSigned(clientSecret, payload)}`;
    deps.log.info({ client: name, confidential }, '[gitquire-oauth] client registered');
    sendOAuthJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: nowSeconds(),
      ...(confidential
        ? { client_secret: registeredClientSecret(clientId), client_secret_expires_at: 0 }
        : {}),
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }

  interface AuthorizeRequest {
    client: OAuthClient;
    redirectUri: string;
    codeChallenge: string;
    state: string | undefined;
  }

  async function parseAuthorize(params: URLSearchParams): Promise<AuthorizeRequest> {
    const client = await resolveClient(params.get('client_id') ?? undefined);
    const redirectUri = params.get('redirect_uri') ?? client.redirectUris[0];
    if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
      throw new OAuthError(400, 'invalid_request', 'The redirect URI is not registered.');
    }
    const resourceParam = params.get('resource');
    if (
      resourceParam !== null &&
      resourceParam !== resource &&
      resourceParam !== issuer &&
      resourceParam !== `${issuer}/`
    ) {
      throw new OAuthError(400, 'invalid_target', 'This server only grants access to its /mcp.');
    }
    if (params.get('response_type') !== 'code') {
      throw new OAuthError(400, 'unsupported_response_type', 'Only response_type=code works.');
    }
    const codeChallenge = params.get('code_challenge');
    if (codeChallenge === null || params.get('code_challenge_method') !== 'S256') {
      throw new OAuthError(400, 'invalid_request', 'PKCE with S256 is required.');
    }
    return {
      client,
      redirectUri,
      codeChallenge,
      state: params.get('state') ?? undefined,
    };
  }

  function returnTo(request: AuthorizeRequest, values: Record<string, string>): string {
    const url = new URL(request.redirectUri);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    if (request.state !== undefined) url.searchParams.set('state', request.state);
    url.searchParams.set('iss', issuer);
    return url.toString();
  }

  function consentPage(
    res: ServerResponse,
    user: SessionUser,
    request: AuthorizeRequest,
    params: URLSearchParams,
  ): void {
    const csrf = encodeSigned(consentSecret, {
      u: user.id,
      exp: nowSeconds() + CONSENT_SECONDS,
    });
    const hidden = [...params.entries()]
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
      )
      .join('');
    const host = new URL(request.redirectUri).host;
    sendHtml(
      res,
      200,
      'Connect an AI app',
      `<p><strong>${escapeHtml(request.client.name)}</strong> wants to read and edit this wiki as <strong>@${escapeHtml(user.login)}</strong>. Its edits will be credited to you.</p>
<p class="muted">After you allow it, you go back to <code>${escapeHtml(host)}</code>. You can revoke access any time at <a href="/auth/agents">AI agent access</a>.</p>
<form method="post" action="${AUTHORIZE_PATH}">${hidden}<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<p><button type="submit" name="decision" value="allow">Allow</button> <button type="submit" name="decision" value="deny">Cancel</button></p>
</form>`,
    );
  }

  function errorPage(res: ServerResponse, err: OAuthError): void {
    sendHtml(res, err.status, 'Cannot connect', `<p>${escapeHtml(err.message)}</p>`);
  }

  async function authorizeGet(
    req: IncomingMessage,
    res: ServerResponse,
    search: string,
  ): Promise<void> {
    const params = new URLSearchParams(search);
    const request = await parseAuthorize(params);
    const user = deps.sessionUser(req);
    if (user === undefined) {
      redirect(res, `/auth/github/login?next=${encodeURIComponent(AUTHORIZE_PATH + search)}`);
      return;
    }
    consentPage(res, user, request, params);
  }

  async function authorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isSameOriginRequest(req, deps.externalUrl)) {
      throw new OAuthError(403, 'access_denied', 'This form must be sent from the wiki itself.');
    }
    const user = deps.sessionUser(req);
    if (user === undefined) {
      throw new OAuthError(401, 'access_denied', 'Your sign-in expired. Start again from the app.');
    }
    const form = await readForm(req);
    const csrf = decodeSigned(consentSecret, form.get('csrf') ?? undefined) as
      | { u?: unknown; exp?: unknown }
      | undefined;
    if (csrf?.u !== user.id || typeof csrf.exp !== 'number' || csrf.exp <= nowSeconds()) {
      throw new OAuthError(400, 'access_denied', 'This page expired. Start again from the app.');
    }
    const decision = form.get('decision');
    form.delete('csrf');
    form.delete('decision');
    const request = await parseAuthorize(form);
    if (decision !== 'allow') {
      redirect(res, returnTo(request, { error: 'access_denied' }));
      return;
    }
    const payload: CodePayload = {
      c: request.client.clientId,
      r: request.redirectUri,
      ch: request.codeChallenge,
      u: user,
      exp: nowSeconds() + CODE_SECONDS,
      j: randomId(),
    };
    deps.log.info(
      { login: user.login, client: request.client.name },
      '[gitquire-oauth] access approved',
    );
    redirect(res, returnTo(request, { code: encodeSigned(codeSecret, payload) }));
  }

  function rememberCode(jti: string, exp: number): boolean {
    const t = nowSeconds();
    for (const [key, until] of usedCodes) if (until <= t) usedCodes.delete(key);
    if (usedCodes.has(jti)) return false;
    usedCodes.set(jti, exp);
    return true;
  }

  async function ensureStillAllowed(login: string): Promise<void> {
    if (deps.checkAccess === undefined) return;
    if ((await deps.checkAccess(login)) === 'denied') {
      throw new OAuthError(400, 'invalid_grant', 'This GitHub account no longer has access.');
    }
  }

  function tokenResponse(res: ServerResponse, issued: IssuedConnectorTokens): void {
    sendOAuthJson(res, 200, {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresInSeconds,
      refresh_token: issued.refreshToken,
      scope: 'wiki',
    });
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const grantType = stringParam(body, 'grant_type');
    const basic = basicClientCredentials(req.headers.authorization);
    const bodyClientId = stringParam(body, 'client_id');
    if (basic !== undefined && bodyClientId !== undefined && bodyClientId !== basic.id) {
      throw new OAuthError(401, 'invalid_client', 'The client credentials disagree.');
    }
    const clientId = basic?.id ?? bodyClientId;
    const presentedSecret = basic?.secret ?? stringParam(body, 'client_secret');
    if (grantType === 'refresh_token') {
      const refreshToken = stringParam(body, 'refresh_token');
      if (refreshToken === undefined || clientId === undefined) {
        throw new OAuthError(400, 'invalid_request', 'refresh_token and client_id are required.');
      }
      await authenticateClient(clientId, presentedSecret);
      const issued = deps.store.refreshConnector(refreshToken, clientId);
      if (issued === undefined) {
        throw new OAuthError(400, 'invalid_grant', 'The refresh token is not valid.');
      }
      try {
        await ensureStillAllowed(issued.record.owner.login);
      } catch (err) {
        deps.store.revoke(issued.record.id, 'admin');
        throw err;
      }
      tokenResponse(res, issued);
      return;
    }
    if (grantType !== 'authorization_code') {
      throw new OAuthError(400, 'unsupported_grant_type', 'Unsupported grant_type.');
    }
    const code = decodeSigned(codeSecret, stringParam(body, 'code')) as
      | Partial<CodePayload>
      | undefined;
    const verifier = stringParam(body, 'code_verifier');
    if (
      code === undefined ||
      typeof code.c !== 'string' ||
      typeof code.r !== 'string' ||
      typeof code.ch !== 'string' ||
      typeof code.exp !== 'number' ||
      typeof code.j !== 'string' ||
      code.u === undefined ||
      code.exp <= nowSeconds()
    ) {
      throw new OAuthError(400, 'invalid_grant', 'The code is not valid or has expired.');
    }
    if (clientId !== undefined && clientId !== code.c) {
      throw new OAuthError(400, 'invalid_grant', 'The code was issued to another client.');
    }
    const redirectUri = stringParam(body, 'redirect_uri');
    if (redirectUri !== undefined && redirectUri !== code.r) {
      throw new OAuthError(400, 'invalid_grant', 'The redirect URI does not match.');
    }
    if (verifier === undefined || !safeEqual(pkceChallenge(verifier), code.ch)) {
      throw new OAuthError(400, 'invalid_grant', 'The code verifier does not match.');
    }
    const client = await authenticateClient(code.c, presentedSecret);
    if (!rememberCode(code.j, code.exp)) {
      throw new OAuthError(400, 'invalid_grant', 'The code was already used.');
    }
    await ensureStillAllowed(code.u.login);
    const owner = code.u;
    tokenResponse(
      res,
      deps.store.createConnector(
        { id: owner.id, login: owner.login, name: owner.name, avatarUrl: owner.avatarUrl },
        client.name,
        client.clientId,
      ),
    );
  }

  function run(res: ServerResponse, asPage: boolean, work: () => Promise<void>): void {
    work().catch((err: unknown) => {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const oauthError =
        err instanceof OAuthError
          ? err
          : new OAuthError(500, 'server_error', 'Something went wrong. Try again.');
      if (!(err instanceof OAuthError)) {
        deps.log.error({ err }, '[gitquire-oauth] request failed');
      }
      if (asPage) {
        errorPage(res, oauthError);
      } else {
        sendOAuthJson(res, oauthError.status, {
          error: oauthError.code,
          error_description: oauthError.message,
        });
      }
    });
  }

  function handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    search: string,
  ): boolean {
    if (path === PROTECTED_RESOURCE_PATH || path === `${PROTECTED_RESOURCE_PATH}/mcp`) {
      sendOAuthJson(res, 200, protectedResource);
      return true;
    }
    if (path === AUTHORIZATION_SERVER_PATH || path === `${AUTHORIZATION_SERVER_PATH}/mcp`) {
      sendOAuthJson(res, 200, authorizationServer);
      return true;
    }
    if (!path.startsWith('/oauth/')) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return true;
    }
    if (path === AUTHORIZE_PATH && req.method === 'GET') {
      run(res, true, () => authorizeGet(req, res, search));
      return true;
    }
    if (path === AUTHORIZE_PATH && req.method === 'POST') {
      run(res, true, () => authorizePost(req, res));
      return true;
    }
    if (path === TOKEN_PATH && req.method === 'POST') {
      run(res, false, () => token(req, res));
      return true;
    }
    if (path === REGISTER_PATH && req.method === 'POST') {
      run(res, false, () => register(req, res));
      return true;
    }
    sendOAuthJson(res, 404, { error: 'not_found' });
    return true;
  }

  return {
    handle,
    wwwAuthenticate: () => `Bearer resource_metadata="${issuer}${PROTECTED_RESOURCE_PATH}/mcp"`,
  };
}
