import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccessGate, SESSION_COOKIE, safeNextPath } from './access-gate.ts';
import { claudeCodeCommand } from './agent-pages.ts';
import { type AgentTokenStore, createAgentTokenStore } from './agent-tokens.ts';
import { resolveGitHubAuthConfig } from './github-auth-config.ts';
import {
  attributeAgentEdit,
  bindAgentConnection,
  requestPrincipal,
  resetPrincipalDirectory,
  takeCommitAuthors,
} from './principal-directory.ts';
import { encodeSigned } from './signed-cookie.ts';

const SECRET = 'x'.repeat(40);
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const EXTERNAL = 'https://wiki.example.com';
const ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.client',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
  GITQUIRE_SESSION_SECRET: SECRET,
  GITQUIRE_REPO: 'acme/notes',
  GITQUIRE_ADMINS: 'boss',
};
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

function sessionCookie(user: { id: number; login: string; name: string }): string {
  const payload = { v: 1, ...user, avatarUrl: '', exp: Math.floor(NOW / 1000) + 3600 };
  return `${SESSION_COOKIE}=${encodeURIComponent(encodeSigned(SECRET, payload))}`;
}

function setup(env: Record<string, string> = ENV): {
  store: AgentTokenStore;
  gate: ReturnType<typeof createAccessGate>;
} {
  const file = join(mkdtempSync(join(tmpdir(), 'gq-agent-gate-')), 'tokens.json');
  const store = createAgentTokenStore({ file, log: silentLog, now: () => NOW });
  const config = resolveGitHubAuthConfig(env, { externalUrl: EXTERNAL });
  if (config === undefined) throw new Error('expected auth');
  const gate = createAccessGate(config, { log: silentLog, now: () => NOW, agentTokens: store });
  return { store, gate };
}

afterEach(() => resetPrincipalDirectory());

describe('agent tokens on /mcp', () => {
  it('admits a personal token and binds the request to its owner', () => {
    const { store, gate } = setup();
    const { token } = store.createPersonal(ALICE, 'laptop', 30);
    const req = fakeRequest('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(gate.handleRequest(req, fakeResponse().res)).toBe(false);
    expect(requestPrincipal(req)).toMatchObject({ id: 'github-42', login: 'alice' });
  });

  it('refuses a missing or revoked token and points at the token page', () => {
    const { store, gate } = setup();
    const { record, token } = store.createPersonal(ALICE, 'laptop', 30);
    store.revoke(record.id, { ownerId: ALICE.id });
    const denied = fakeResponse();
    const req = fakeRequest('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(gate.handleRequest(req, denied.res)).toBe(true);
    expect(denied.status).toBe(401);
    expect(JSON.parse(denied.body)).toMatchObject({ tokens: '/auth/agents' });
    expect(requestPrincipal(req)).toBeUndefined();
  });

  it('still accepts the shared token, without a person attached', () => {
    const { gate } = setup({ ...ENV, GITQUIRE_MCP_TOKEN: 'shared-secret' });
    const req = fakeRequest('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer shared-secret' },
    });
    expect(gate.handleRequest(req, fakeResponse().res)).toBe(false);
    expect(requestPrincipal(req)).toBeUndefined();
  });
});

describe('agent edits are credited to the token owner', () => {
  it('maps an MCP connection to its owner for commits', () => {
    bindAgentConnection('conn-1', {
      id: 'github-42',
      login: 'alice',
      name: 'Alice A',
      email: '42+alice@users.noreply.github.com',
    });
    expect(attributeAgentEdit('conn-1')).toMatchObject({
      id: 'github-42',
      name: 'Alice A',
      email: '42+alice@users.noreply.github.com',
    });
    expect(attributeAgentEdit('someone-else')).toBeUndefined();
    expect(takeCommitAuthors().map((a) => a.login)).toEqual(['alice']);
  });
});

describe('the agent access page', () => {
  it('sends signed-out visitors through sign-in and back', () => {
    const { gate } = setup();
    const res = fakeResponse();
    gate.handleRequest(fakeRequest('/auth/agents', { headers: { accept: 'text/html' } }), res.res);
    expect(res.status).toBe(302);
    expect(res.headers.Location).toBe('/auth/github/login?next=%2Fauth%2Fagents');
    expect(safeNextPath('/auth/agents')).toBe('/auth/agents');
    expect(safeNextPath('/auth/logout')).toBe('/');
  });

  it('creates a token once, with ready-to-paste setup', async () => {
    const { store, gate } = setup();
    const res = fakeResponse();
    gate.handleRequest(
      fakeRequest('/auth/agents', {
        method: 'POST',
        headers: { cookie: sessionCookie(ALICE), origin: EXTERNAL },
        body: 'label=Claude+Code+on+my+laptop',
      }),
      res.res,
    );
    await res.done;
    expect(res.status).toBe(200);
    const [record] = store.list(ALICE.id);
    expect(record?.label).toBe('Claude Code on my laptop');
    const token = /<pre>(gqa_[^<]+)<\/pre>/.exec(res.body)?.[1];
    expect(token).toBeDefined();
    expect(store.verify(token ?? '')?.owner.login).toBe('alice');
    expect(res.body).toContain(
      'claude mcp add --transport http gitquire https://wiki.example.com/mcp',
    );

    const again = fakeResponse();
    gate.handleRequest(
      fakeRequest('/auth/agents', { headers: { cookie: sessionCookie(ALICE) } }),
      again.res,
    );
    expect(again.body).toContain('Claude Code on my laptop');
    expect(again.body).not.toContain(token);
  });

  it('refuses a form posted from another site', async () => {
    const { store, gate } = setup();
    const res = fakeResponse();
    gate.handleRequest(
      fakeRequest('/auth/agents', {
        method: 'POST',
        headers: { cookie: sessionCookie(ALICE), origin: 'https://evil.example' },
        body: 'label=x',
      }),
      res.res,
    );
    await res.done;
    expect(res.status).toBe(403);
    expect(store.list()).toHaveLength(0);
  });

  it("lets people revoke their own tokens but not someone else's", async () => {
    const { store, gate } = setup();
    const bobs = store.createPersonal({ ...ALICE, id: 7, login: 'bob' }, 'bob', 30);
    const res = fakeResponse();
    gate.handleRequest(
      fakeRequest('/auth/agents/revoke', {
        method: 'POST',
        headers: { cookie: sessionCookie(ALICE), origin: EXTERNAL },
        body: `id=${bobs.record.id}`,
      }),
      res.res,
    );
    await res.done;
    expect(res.body).toContain('Nothing revoked');
    expect(store.verify(bobs.token)).toBeDefined();

    const admin = fakeResponse();
    gate.handleRequest(
      fakeRequest('/auth/agents/revoke', {
        method: 'POST',
        headers: {
          cookie: sessionCookie({ id: 1, login: 'boss', name: 'Boss' }),
          origin: EXTERNAL,
        },
        body: `id=${bobs.record.id}`,
      }),
      admin.res,
    );
    await admin.done;
    expect(admin.body).toContain('Revoked.');
    expect(store.verify(bobs.token)).toBeUndefined();
  });

  it('tells the app which kinds of agent access the person has', () => {
    const { store, gate } = setup();
    const me = () => {
      const res = fakeResponse();
      gate.handleRequest(
        fakeRequest('/auth/me', { headers: { cookie: sessionCookie(ALICE) } }),
        res.res,
      );
      return JSON.parse(res.body).features;
    };
    expect(me()).toEqual({ askAi: false, agentToken: false, connector: false });
    store.createPersonal(ALICE, 'laptop', 30);
    expect(me()).toMatchObject({ agentToken: true, connector: false });
    store.createConnector(ALICE, 'Claude', 'https://claude.ai/client.json');
    expect(me()).toMatchObject({ agentToken: true, connector: true });
  });

  it('builds the Claude Code command from the external URL', () => {
    expect(claudeCodeCommand(new URL(EXTERNAL), 'gqa_t')).toBe(
      'claude mcp add --transport http gitquire https://wiki.example.com/mcp --header "Authorization: Bearer gqa_t"',
    );
  });
});
