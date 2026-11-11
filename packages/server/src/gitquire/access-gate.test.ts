import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  type AccessGate,
  createAccessGate,
  isPublicAsset,
  noreplyEmail,
  SESSION_COOKIE,
  STATE_COOKIE,
  safeNextPath,
} from './access-gate.ts';
import { resolveGitHubAuthConfig } from './github-auth-config.ts';
import { encodeSigned } from './signed-cookie.ts';

const SECRET = 'x'.repeat(40);
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

const BASE_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.client',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
  GITQUIRE_SESSION_SECRET: SECRET,
  GITQUIRE_REPO: 'acme/notes',
  GITQUIRE_ADMINS: 'boss',
  GITQUIRE_MCP_TOKEN: 'mcp-secret',
};

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

interface FakeResponse {
  status: number | undefined;
  headers: Record<string, unknown>;
  body: string;
  done: Promise<void>;
  res: ServerResponse;
}

function fakeResponse(): FakeResponse {
  const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
  const state: FakeResponse = {
    status: undefined,
    headers: {},
    body: '',
    done,
    res: undefined as unknown as ServerResponse,
  };
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
      resolveDone();
      return res;
    },
  };
  state.res = res as unknown as ServerResponse;
  return state;
}

function fakeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): IncomingMessage {
  return { url, method: init.method ?? 'GET', headers: init.headers ?? {} } as IncomingMessage;
}

function cookiesFrom(setCookie: unknown): Map<string, string> {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const jar = new Map<string, string>();
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const [pair] = entry.split(';');
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
  }
  return jar;
}

interface FakeSocket {
  written: string;
  destroyed: boolean;
  socket: Duplex;
}

function fakeSocket(): FakeSocket {
  const state: FakeSocket = {
    written: '',
    destroyed: false,
    socket: undefined as unknown as Duplex,
  };
  state.socket = {
    write(chunk: string) {
      state.written += chunk;
      return true;
    },
    destroy() {
      state.destroyed = true;
    },
  } as unknown as Duplex;
  return state;
}

interface GitHubStub {
  push: boolean;
  calls: string[];
}

function githubFetch(stub: GitHubStub): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    stub.calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token') {
      return new Response(JSON.stringify({ access_token: 'user-token' }), { status: 200 });
    }
    if (url === 'https://api.github.com/user') {
      return new Response(
        JSON.stringify({ id: 42, login: 'alice', name: 'Alice A', avatar_url: 'https://a/42' }),
        { status: 200 },
      );
    }
    if (url === 'https://api.github.com/repos/acme/notes') {
      return new Response(JSON.stringify({ permissions: { push: stub.push } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

function makeGate(
  env: Record<string, string> = BASE_ENV,
  stub: GitHubStub = { push: true, calls: [] },
): AccessGate {
  const config = resolveGitHubAuthConfig(env, { externalUrl: 'https://brain.example.com' });
  if (config === undefined) throw new Error('expected auth to be enabled');
  return createAccessGate(config, {
    log: silentLog,
    fetch: githubFetch(stub),
    now: () => NOW,
    randomState: () => 'fixed-state',
  });
}

function sessionCookie(overrides: Record<string, unknown> = {}): string {
  const payload = {
    v: 1,
    id: 42,
    login: 'alice',
    name: 'Alice A',
    avatarUrl: 'https://a/42',
    exp: Math.floor(NOW / 1000) + 3600,
    ...overrides,
  };
  return `${SESSION_COOKIE}=${encodeURIComponent(encodeSigned(SECRET, payload))}`;
}

async function signIn(gate: AccessGate): Promise<FakeResponse> {
  const login = fakeResponse();
  gate.handleRequest(fakeRequest('/auth/github/login?next=%2Fdocs%2Fplan'), login.res);
  const state = cookiesFrom(login.headers['Set-Cookie']).get(STATE_COOKIE);
  const callback = fakeResponse();
  gate.handleRequest(
    fakeRequest('/auth/github/callback?code=abc&state=fixed-state', {
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(state ?? '')}` },
    }),
    callback.res,
  );
  await callback.done;
  return callback;
}

describe('resolveGitHubAuthConfig', () => {
  it('stays off without a client id', () => {
    expect(resolveGitHubAuthConfig({}, { externalUrl: undefined })).toBeUndefined();
  });

  it('stays off when GITQUIRE_AUTH=off', () => {
    expect(
      resolveGitHubAuthConfig({ ...BASE_ENV, GITQUIRE_AUTH: 'off' }, { externalUrl: undefined }),
    ).toBeUndefined();
  });

  it('names every missing setting', () => {
    expect(() =>
      resolveGitHubAuthConfig({ GITQUIRE_AUTH: 'github' }, { externalUrl: undefined }),
    ).toThrow(
      'GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITQUIRE_SESSION_SECRET, OK_EXTERNAL_URL',
    );
  });

  it('rejects a short session secret', () => {
    expect(() =>
      resolveGitHubAuthConfig(
        { ...BASE_ENV, GITQUIRE_SESSION_SECRET: 'short' },
        { externalUrl: 'https://brain.example.com' },
      ),
    ).toThrow('at least 32 characters');
  });

  it('requires a repo or an allowlist', () => {
    const { GITQUIRE_REPO: _repo, ...env } = BASE_ENV;
    expect(() =>
      resolveGitHubAuthConfig(env, { externalUrl: 'https://brain.example.com' }),
    ).toThrow('GITQUIRE_REPO');
  });

  it('accepts a repo URL and normalizes logins', () => {
    const config = resolveGitHubAuthConfig(
      {
        ...BASE_ENV,
        GITQUIRE_REPO: 'https://github.com/acme/notes.git',
        GITQUIRE_ALLOWED_USERS: '@Bob, carol',
      },
      { externalUrl: 'https://brain.example.com' },
    );
    expect(config?.repo).toEqual({ owner: 'acme', name: 'notes' });
    expect([...(config?.allowedUsers ?? [])]).toEqual(['bob', 'carol']);
  });

  it('falls back to OK_EXTERNAL_URL from the environment', () => {
    const config = resolveGitHubAuthConfig(
      { ...BASE_ENV, OK_EXTERNAL_URL: 'https://wiki.example.org' },
      { externalUrl: undefined },
    );
    expect(config?.externalUrl.toString()).toBe('https://wiki.example.org/');
  });
});

describe('isPublicAsset', () => {
  it('lets browsers fetch the app manifest and icons without a session', () => {
    expect(isPublicAsset('/manifest.webmanifest', 'GET')).toBe(true);
    expect(isPublicAsset('/icons/gitquire-192.png', 'GET')).toBe(true);
    expect(isPublicAsset('/favicon.svg', 'HEAD')).toBe(true);
    expect(isPublicAsset('/icons/../api/config', 'GET')).toBe(false);
    expect(isPublicAsset('/manifest.webmanifest', 'POST')).toBe(false);
    expect(isPublicAsset('/api/documents', 'GET')).toBe(false);
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/docs/a?x=1', '/docs/a?x=1'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['/auth/logout', '/'],
    [null, '/'],
  ])('maps %s to %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe('createAccessGate requests', () => {
  it('lets health probes through', () => {
    const gate = makeGate();
    expect(gate.handleRequest(fakeRequest('/healthz'), fakeResponse().res)).toBe(false);
    expect(gate.handleRequest(fakeRequest('/readyz'), fakeResponse().res)).toBe(false);
  });

  it('redirects a signed-out browser to sign-in, keeping the page', () => {
    const gate = makeGate();
    const out = fakeResponse();
    const handled = gate.handleRequest(
      fakeRequest('/docs/plan?tab=2', { headers: { accept: 'text/html' } }),
      out.res,
    );
    expect(handled).toBe(true);
    expect(out.status).toBe(302);
    expect(out.headers.Location).toBe('/auth/github/login?next=%2Fdocs%2Fplan%3Ftab%3D2');
  });

  it('answers signed-out API calls with 401', () => {
    const gate = makeGate();
    const out = fakeResponse();
    expect(gate.handleRequest(fakeRequest('/api/config'), out.res)).toBe(true);
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body)).toMatchObject({ error: 'not-signed-in' });
  });

  it('starts the GitHub flow with a signed state cookie', () => {
    const gate = makeGate();
    const out = fakeResponse();
    gate.handleRequest(fakeRequest('/auth/github/login?next=%2Fdocs'), out.res);
    expect(out.status).toBe(302);
    const location = new URL(String(out.headers.Location));
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('Iv1.client');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://brain.example.com/auth/github/callback',
    );
    expect(location.searchParams.get('state')).toBe('fixed-state');
    const setCookie = String(out.headers['Set-Cookie']);
    expect(setCookie).toContain(`${STATE_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
  });

  it('signs in a user with write access and returns to the page', async () => {
    const stub = { push: true, calls: [] as string[] };
    const gate = makeGate(BASE_ENV, stub);
    const callback = await signIn(gate);
    expect(callback.status).toBe(302);
    expect(callback.headers.Location).toBe('/docs/plan');
    const session = cookiesFrom(callback.headers['Set-Cookie']).get(SESSION_COOKIE);
    expect(session).toBeTruthy();
    expect(stub.calls).toContain('https://api.github.com/repos/acme/notes');

    const req = fakeRequest('/docs/plan', {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session ?? '')}` },
    });
    expect(gate.handleRequest(req, fakeResponse().res)).toBe(false);
    expect(gate.sessionUser(req)).toEqual({
      id: 42,
      login: 'alice',
      name: 'Alice A',
      avatarUrl: 'https://a/42',
    });
  });

  it('refuses a user without write access', async () => {
    const gate = makeGate(BASE_ENV, { push: false, calls: [] });
    const callback = await signIn(gate);
    expect(callback.status).toBe(403);
    expect(callback.body).toContain('@alice');
    expect(callback.body).toContain('acme/notes');
    expect(cookiesFrom(callback.headers['Set-Cookie']).get(SESSION_COOKIE)).toBeUndefined();
  });

  it('admits an allowlisted user without a repo check', async () => {
    const { GITQUIRE_REPO: _repo, ...env } = BASE_ENV;
    const stub = { push: false, calls: [] as string[] };
    const gate = makeGate({ ...env, GITQUIRE_ALLOWED_USERS: 'Alice' }, stub);
    const callback = await signIn(gate);
    expect(callback.status).toBe(302);
    expect(stub.calls).not.toContain('https://api.github.com/repos/acme/notes');
  });

  it('rejects a callback whose state does not match', async () => {
    const gate = makeGate();
    const out = fakeResponse();
    const state = encodeSigned(SECRET, { state: 'other', next: '/', exp: NOW / 1000 + 60 });
    gate.handleRequest(
      fakeRequest('/auth/github/callback?code=abc&state=fixed-state', {
        headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(state)}` },
      }),
      out.res,
    );
    await out.done;
    expect(out.status).toBe(400);
  });

  it('rejects a tampered or expired session cookie', () => {
    const gate = makeGate();
    const tampered = sessionCookie().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(gate.sessionUser(fakeRequest('/', { headers: { cookie: tampered } }))).toBeUndefined();
    const expired = sessionCookie({ exp: Math.floor(NOW / 1000) - 1 });
    expect(gate.sessionUser(fakeRequest('/', { headers: { cookie: expired } }))).toBeUndefined();
    const forgedValue = encodeSigned('y'.repeat(40), { v: 1 });
    const forged = `${SESSION_COOKIE}=${encodeURIComponent(forgedValue)}`;
    expect(gate.sessionUser(fakeRequest('/', { headers: { cookie: forged } }))).toBeUndefined();
  });

  it('answers /api/principal with the signed-in GitHub user', () => {
    const gate = makeGate();
    const out = fakeResponse();
    const req = fakeRequest('/api/principal', { headers: { cookie: sessionCookie() } });
    expect(gate.handleRequest(req, out.res)).toBe(true);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({
      id: 'github-42',
      display_name: 'Alice A',
      display_email: '42+alice@users.noreply.github.com',
      source: 'git-config',
      created_at: new Date(NOW).toISOString(),
    });
  });

  it('reports the signed-in user on /auth/me', () => {
    const gate = makeGate();
    const out = fakeResponse();
    gate.handleRequest(fakeRequest('/auth/me', { headers: { cookie: sessionCookie() } }), out.res);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toMatchObject({
      login: 'alice',
      email: noreplyEmail({ id: 42, login: 'alice' }),
      admin: false,
      features: { askAi: false, agentToken: false, connector: false },
    });
  });

  it('turns Ask AI on with GITQUIRE_ASK_AI', () => {
    const gate = makeGate({ ...BASE_ENV, GITQUIRE_ASK_AI: 'on' });
    const out = fakeResponse();
    gate.handleRequest(fakeRequest('/auth/me', { headers: { cookie: sessionCookie() } }), out.res);
    expect(JSON.parse(out.body).features).toMatchObject({ askAi: true });
  });

  it('only clears the session on a POST to logout', () => {
    const gate = makeGate();
    const page = fakeResponse();
    const get = fakeRequest('/auth/logout', { headers: { cookie: sessionCookie() } });
    gate.handleRequest(get, page.res);
    expect(page.status).toBe(200);
    expect(page.headers['Set-Cookie']).toBeUndefined();
    expect(page.body).toContain('method="post"');
    expect(page.body).toContain('@alice');

    const out = fakeResponse();
    const post = fakeRequest('/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie() },
    });
    gate.handleRequest(post, out.res);
    expect(String(out.headers['Set-Cookie'])).toContain(`${SESSION_COOKIE}=; `);
    expect(String(out.headers['Set-Cookie'])).toContain('Max-Age=0');
  });

  it('keeps server administration routes for admins', () => {
    const gate = makeGate();
    const member = { cookie: sessionCookie() };
    const admin = { cookie: sessionCookie({ login: 'Boss' }) };
    const clone = fakeResponse();
    expect(
      gate.handleRequest(
        fakeRequest('/api/local-op/clone', { method: 'POST', headers: member }),
        clone.res,
      ),
    ).toBe(true);
    expect(clone.status).toBe(403);
    expect(
      gate.handleRequest(
        fakeRequest('/api/local-op/auth/status', { headers: member }),
        fakeResponse().res,
      ),
    ).toBe(false);
    expect(
      gate.handleRequest(
        fakeRequest('/api/local-op/clone', { method: 'POST', headers: admin }),
        fakeResponse().res,
      ),
    ).toBe(false);
  });

  it('requires the bearer token on /mcp', () => {
    const gate = makeGate();
    const denied = fakeResponse();
    expect(gate.handleRequest(fakeRequest('/mcp', { method: 'POST' }), denied.res)).toBe(true);
    expect(denied.status).toBe(401);
    expect(
      gate.handleRequest(
        fakeRequest('/mcp', { method: 'POST', headers: { authorization: 'Bearer mcp-secret' } }),
        fakeResponse().res,
      ),
    ).toBe(false);
  });
});

describe('createAccessGate upgrades', () => {
  it('refuses a live-editing socket without a session', () => {
    const gate = makeGate();
    const sock = fakeSocket();
    expect(gate.admitUpgrade(fakeRequest('/collab'), sock.socket)).toBe(false);
    expect(sock.written).toContain('401 Unauthorized');
    expect(sock.destroyed).toBe(true);
  });

  it('admits a live-editing socket with a session', () => {
    const gate = makeGate();
    const sock = fakeSocket();
    const req = fakeRequest('/collab', { headers: { cookie: sessionCookie() } });
    expect(gate.admitUpgrade(req, sock.socket)).toBe(true);
    expect(sock.destroyed).toBe(false);
  });

  it('admits the agent keepalive socket with the MCP token', () => {
    const gate = makeGate();
    const req = fakeRequest('/collab/keepalive', {
      headers: { authorization: 'Bearer mcp-secret' },
    });
    expect(gate.admitUpgrade(req, fakeSocket().socket)).toBe(true);
  });

  it('leaves other upgrade paths to the server', () => {
    const gate = makeGate();
    expect(gate.admitUpgrade(fakeRequest('/other'), fakeSocket().socket)).toBe(true);
  });
});
