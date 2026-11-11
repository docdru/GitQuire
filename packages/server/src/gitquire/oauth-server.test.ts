import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAccessGate, SESSION_COOKIE } from './access-gate.ts';
import type { AccessVerdict } from './agent-access.ts';
import { type AgentTokenStore, createAgentTokenStore } from './agent-tokens.ts';
import { resolveGitHubAuthConfig } from './github-auth-config.ts';
import { isAllowedRedirectUri, isMetadataDocumentClientId, pkceChallenge } from './oauth-server.ts';
import { encodeSigned } from './signed-cookie.ts';

const SECRET = 'y'.repeat(40);
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const EXTERNAL = 'https://wiki.example.com';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';
const VERIFIER = 'v'.repeat(50);
const ENV_WITHOUT_CONNECTORS = {
  GITHUB_APP_CLIENT_ID: 'Iv1.client',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
  GITQUIRE_SESSION_SECRET: SECRET,
  GITQUIRE_REPO: 'acme/notes',
};
const ENV = { ...ENV_WITHOUT_CONNECTORS, GITQUIRE_MCP_CONNECTORS: 'on' };
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const ALICE = { id: 42, login: 'alice', name: 'Alice A', avatarUrl: 'https://a/42' };

interface FakeResponse {
  status: number | undefined;
  headers: Record<string, unknown>;
  body: string;
  done: Promise<void>;
  res: ServerResponse;
}

function fakeResponse(): FakeResponse {
  const { promise: done, resolve } = Promise.withResolvers<void>();
  const state = { status: undefined, headers: {}, body: '', done } as unknown as FakeResponse;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number, headers: Record<string, unknown>) {
      state.status = status;
      state.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) state.body += chunk;
      res.writableEnded = true;
      resolve();
      return res;
    },
  };
  state.res = res as unknown as ServerResponse;
  return state;
}

function fakeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): IncomingMessage {
  const stream = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]);
  return Object.assign(stream, {
    url,
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
  }) as unknown as IncomingMessage;
}

const cookie = `${SESSION_COOKIE}=${encodeURIComponent(
  encodeSigned(SECRET, { v: 1, ...ALICE, exp: Math.floor(NOW / 1000) + 3600 }),
)}`;

function metadataFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (String(input) !== CIMD) return new Response('{}', { status: 404 });
    return new Response(
      JSON.stringify({ client_id: CIMD, client_name: 'Claude', redirect_uris: [CALLBACK] }),
      { status: 200 },
    );
  }) as typeof fetch;
}

interface SetupOptions {
  env?: Record<string, string>;
  access?: AccessVerdict;
}

function setup(options: SetupOptions = {}): {
  store: AgentTokenStore;
  gate: ReturnType<typeof createAccessGate>;
} {
  const file = join(mkdtempSync(join(tmpdir(), 'gq-oauth-')), 'tokens.json');
  const store = createAgentTokenStore({ file, log: silentLog, now: () => NOW });
  const config = resolveGitHubAuthConfig(options.env ?? ENV, { externalUrl: EXTERNAL });
  if (config === undefined) throw new Error('expected auth');
  const gate = createAccessGate(config, {
    log: silentLog,
    now: () => NOW,
    fetch: metadataFetch(),
    agentTokens: store,
    checkAccess: async () => options.access ?? 'allowed',
  });
  return { store, gate };
}

async function send(
  gate: ReturnType<typeof createAccessGate>,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<FakeResponse> {
  const res = fakeResponse();
  const handled = gate.handleRequest(fakeRequest(url, init), res.res);
  if (!handled) throw new Error(`gate passed ${url} through`);
  await res.done;
  return res;
}

function authorizeQuery(clientId: string): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${EXTERNAL}/mcp`,
  }).toString();
}

async function approve(gate: ReturnType<typeof createAccessGate>, clientId: string) {
  const consent = await send(gate, `/oauth/authorize?${authorizeQuery(clientId)}`, {
    headers: { cookie },
  });
  expect(consent.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)?.[1] ?? '';
  const form = new URLSearchParams(authorizeQuery(clientId));
  form.set('csrf', csrf);
  form.set('decision', 'allow');
  const approved = await send(gate, '/oauth/authorize', {
    method: 'POST',
    headers: { cookie, origin: EXTERNAL, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  expect(approved.status).toBe(302);
  return new URL(String(approved.headers.Location));
}

async function exchange(
  gate: ReturnType<typeof createAccessGate>,
  fields: Record<string, string>,
): Promise<FakeResponse> {
  return send(gate, '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('OAuth discovery', () => {
  it('points /mcp callers at the protected-resource metadata', async () => {
    const { gate } = setup();
    const res = await send(gate, '/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers['WWW-Authenticate']).toBe(
      `Bearer resource_metadata="${EXTERNAL}/.well-known/oauth-protected-resource/mcp"`,
    );
    const resource = JSON.parse(
      (await send(gate, '/.well-known/oauth-protected-resource/mcp')).body,
    );
    expect(resource).toMatchObject({
      resource: `${EXTERNAL}/mcp`,
      authorization_servers: [EXTERNAL],
    });
    const server = JSON.parse((await send(gate, '/.well-known/oauth-authorization-server')).body);
    expect(server).toMatchObject({
      issuer: EXTERNAL,
      token_endpoint: `${EXTERNAL}/oauth/token`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });

  it('stays off unless GITQUIRE_MCP_CONNECTORS is set', async () => {
    const { gate } = setup({ env: ENV_WITHOUT_CONNECTORS });
    const res = await send(gate, '/mcp', { method: 'POST' });
    expect(res.headers['WWW-Authenticate']).toBe('Bearer');
    const wellKnown = fakeResponse();
    gate.handleRequest(fakeRequest('/.well-known/oauth-authorization-server'), wellKnown.res);
    expect(wellKnown.status).not.toBe(200);
  });
});

describe('OAuth sign-in for connectors', () => {
  it('runs the full flow with a metadata-document client', async () => {
    const { store, gate } = setup();
    const back = await approve(gate, CIMD);
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(EXTERNAL);
    const code = back.searchParams.get('code') ?? '';

    const tokens = await exchange(gate, {
      grant_type: 'authorization_code',
      code,
      client_id: CIMD,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(tokens.status).toBe(200);
    const body = JSON.parse(tokens.body) as Record<string, string>;
    expect(body.token_type).toBe('Bearer');
    expect(store.verify(body.access_token ?? '')).toMatchObject({
      kind: 'connector',
      label: 'Claude',
      owner: { login: 'alice' },
    });

    const mcp = fakeResponse();
    const passed = gate.handleRequest(
      fakeRequest('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${body.access_token}` },
      }),
      mcp.res,
    );
    expect(passed).toBe(false);

    const reused = await exchange(gate, {
      grant_type: 'authorization_code',
      code,
      client_id: CIMD,
      code_verifier: VERIFIER,
    });
    expect(JSON.parse(reused.body).error).toBe('invalid_grant');

    const refreshed = await exchange(gate, {
      grant_type: 'refresh_token',
      refresh_token: body.refresh_token ?? '',
      client_id: CIMD,
    });
    expect(refreshed.status).toBe(200);
    const next = JSON.parse(refreshed.body) as Record<string, string>;
    expect(store.verify(next.access_token ?? '')?.owner.login).toBe('alice');
    expect(store.verify(body.access_token ?? '')).toBeUndefined();
  });

  it('registers a client dynamically and accepts it', async () => {
    const { gate } = setup();
    const registered = await send(gate, '/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Cursor', redirect_uris: [CALLBACK] }),
    });
    expect(registered.status).toBe(201);
    const clientId = (JSON.parse(registered.body) as { client_id: string }).client_id;
    const back = await approve(gate, clientId);
    expect(back.searchParams.get('code')).toBeTruthy();
  });

  it('refuses a wrong code verifier', async () => {
    const { gate } = setup();
    const back = await approve(gate, CIMD);
    const res = await exchange(gate, {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      client_id: CIMD,
      code_verifier: 'w'.repeat(50),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_grant');
  });

  it('refuses people who lost access to the repository', async () => {
    const { gate } = setup({ access: 'denied' });
    const back = await approve(gate, CIMD);
    const res = await exchange(gate, {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      client_id: CIMD,
      code_verifier: VERIFIER,
    });
    expect(JSON.parse(res.body).error).toBe('invalid_grant');
  });

  it('sends signed-out people through GitHub sign-in first', async () => {
    const { gate } = setup();
    const res = await send(gate, `/oauth/authorize?${authorizeQuery(CIMD)}`);
    expect(res.status).toBe(302);
    const location = String(res.headers.Location);
    expect(location.startsWith('/auth/github/login?next=%2Foauth%2Fauthorize')).toBe(true);
  });

  it('refuses an unregistered redirect URI without redirecting', async () => {
    const { gate } = setup();
    const query = new URLSearchParams(authorizeQuery(CIMD));
    query.set('redirect_uri', 'https://evil.example/callback');
    const res = await send(gate, `/oauth/authorize?${query}`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(res.headers.Location).toBeUndefined();
  });

  it('honours Cancel on the consent page', async () => {
    const { gate } = setup();
    const consent = await send(gate, `/oauth/authorize?${authorizeQuery(CIMD)}`, {
      headers: { cookie },
    });
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)?.[1] ?? '';
    const form = new URLSearchParams(authorizeQuery(CIMD));
    form.set('csrf', csrf);
    form.set('decision', 'deny');
    const res = await send(gate, '/oauth/authorize', {
      method: 'POST',
      headers: { cookie, origin: EXTERNAL },
      body: form.toString(),
    });
    expect(new URL(String(res.headers.Location)).searchParams.get('error')).toBe('access_denied');
  });
});

describe('client checks', () => {
  it('accepts https and loopback redirect URIs only', () => {
    expect(isAllowedRedirectUri(CALLBACK)).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:3334/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://example.com/callback')).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
  });

  it('only fetches metadata documents from https host names', () => {
    expect(isMetadataDocumentClientId(CIMD)).toBe(true);
    expect(isMetadataDocumentClientId('https://10.0.0.1/client.json')).toBe(false);
    expect(isMetadataDocumentClientId('https://localhost/client.json')).toBe(false);
    expect(isMetadataDocumentClientId('http://claude.ai/client.json')).toBe(false);
    expect(isMetadataDocumentClientId('gqc_abc')).toBe(false);
  });
});
