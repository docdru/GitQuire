import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepoAccessCheck, startAccessSweep } from './agent-access.ts';
import {
  AgentTokenLimitError,
  createAgentTokenStore,
  MAX_PERSONAL_TOKENS_PER_USER,
  parseAgentToken,
} from './agent-tokens.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 24 * 60 * 60 * 1000;
const ALICE = { id: 42, login: 'alice', name: 'Alice A', avatarUrl: 'https://a/42' };
const BOB = { id: 7, login: 'bob', name: 'Bob B', avatarUrl: 'https://a/7' };

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'gq-agent-tokens-')), 'nested', 'agent-tokens.json');
}

function makeStore(file = tempFile(), clock = { t: Date.UTC(2026, 10, 11) }) {
  const store = createAgentTokenStore({ file, log: silentLog, now: () => clock.t });
  return { store, file, clock };
}

describe('agent token store', () => {
  it('creates a personal token that verifies and is stored only as a hash', () => {
    const { store, file } = makeStore();
    const { record, token } = store.createPersonal(ALICE, 'Claude Code on my laptop', 90);
    expect(parseAgentToken(token)?.type).toBe('access');
    expect(store.verify(token)?.owner.login).toBe('alice');
    expect(record.label).toBe('Claude Code on my laptop');
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain(parseAgentToken(token)?.secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rejects wrong, malformed and expired tokens', () => {
    const { store, clock } = makeStore();
    const { token } = store.createPersonal(ALICE, 'x', 1);
    const wrong = `${token.slice(0, -4)}AAAA`;
    expect(store.verify(wrong)).toBeUndefined();
    expect(store.verify('mcp-secret')).toBeUndefined();
    clock.t += 2 * DAY;
    expect(store.verify(token)).toBeUndefined();
    expect(store.list(ALICE.id)).toHaveLength(0);
  });

  it('survives a restart', () => {
    const { store, file, clock } = makeStore();
    const { token } = store.createPersonal(ALICE, 'x', 30);
    const reopened = createAgentTokenStore({ file, log: silentLog, now: () => clock.t });
    expect(reopened.verify(token)?.owner.id).toBe(ALICE.id);
  });

  it('lets only the owner or an admin revoke a token', () => {
    const { store } = makeStore();
    const { record, token } = store.createPersonal(ALICE, 'x', 30);
    expect(store.revoke(record.id, { ownerId: BOB.id })).toBe(false);
    expect(store.verify(token)).toBeDefined();
    expect(store.revoke(record.id, { ownerId: ALICE.id })).toBe(true);
    expect(store.verify(token)).toBeUndefined();
    const second = store.createPersonal(ALICE, 'y', 30);
    expect(store.revoke(second.record.id, 'admin')).toBe(true);
  });

  it('caps personal tokens per person', () => {
    const { store } = makeStore();
    for (let i = 0; i < MAX_PERSONAL_TOKENS_PER_USER; i += 1) {
      store.createPersonal(ALICE, `t${i}`, 30);
    }
    expect(() => store.createPersonal(ALICE, 'one more', 30)).toThrow(AgentTokenLimitError);
    expect(() => store.createPersonal(BOB, 'bob is fine', 30)).not.toThrow();
  });

  it('rotates connector tokens on refresh and keeps one grant per client', () => {
    const { store, clock } = makeStore();
    const first = store.createConnector(ALICE, 'Claude', 'https://claude.ai/client.json');
    expect(store.verify(first.accessToken)?.kind).toBe('connector');
    expect(store.verify(first.refreshToken)).toBeUndefined();

    clock.t += 2 * 60 * 60 * 1000;
    expect(store.verify(first.accessToken)).toBeUndefined();
    const client = 'https://claude.ai/client.json';
    expect(store.refreshConnector(first.refreshToken, 'https://other.example/c')).toBeUndefined();
    const second = store.refreshConnector(first.refreshToken, client);
    expect(second).toBeDefined();
    expect(store.verify(second?.accessToken ?? '')?.owner.login).toBe('alice');
    expect(store.refreshConnector(first.refreshToken, client)).toBeUndefined();

    store.createConnector(ALICE, 'Claude', client);
    expect(store.list(ALICE.id).filter((r) => r.kind === 'connector')).toHaveLength(1);
  });

  it('revokes everything a person holds', () => {
    const { store } = makeStore();
    store.createPersonal(ALICE, 'a', 30);
    store.createConnector(ALICE, 'Claude', 'c');
    store.createPersonal(BOB, 'b', 30);
    expect(store.revokeOwner(ALICE.id)).toBe(2);
    expect(store.owners().map((o) => o.login)).toEqual(['bob']);
  });
});

describe('repository access check', () => {
  const repo = { owner: 'acme', name: 'notes' };
  const api = 'https://api.github.com';

  function fetchReturning(status: number, body: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  }

  it('allows listed users without asking GitHub', async () => {
    const check = createRepoAccessCheck(
      { allowedUsers: new Set(['alice']), repo, githubApiUrl: api },
      { fetch: () => Promise.reject(new Error('no network')) },
    );
    expect(await check('Alice')).toBe('allowed');
  });

  it('reads the collaborator role with the app token', async () => {
    const base = { allowedUsers: new Set<string>(), repo, githubApiUrl: api };
    const token = () => 'inst-token';
    expect(
      await createRepoAccessCheck(base, {
        installationToken: token,
        fetch: fetchReturning(200, { permission: 'write', role_name: 'write' }),
      })('bob'),
    ).toBe('allowed');
    expect(
      await createRepoAccessCheck(base, {
        installationToken: token,
        fetch: fetchReturning(200, { permission: 'read', role_name: 'read' }),
      })('bob'),
    ).toBe('denied');
    const withStatus = (status: number) =>
      createRepoAccessCheck(base, { installationToken: token, fetch: fetchReturning(status, {}) });
    expect(await withStatus(404)('bob')).toBe('denied');
    expect(await withStatus(502)('bob')).toBe('unknown');
    expect(await createRepoAccessCheck(base, {})('bob')).toBe('unknown');
  });

  it('denies unlisted users when there is no repository', async () => {
    const check = createRepoAccessCheck(
      { allowedUsers: new Set(['alice']), repo: undefined, githubApiUrl: api },
      {},
    );
    expect(await check('mallory')).toBe('denied');
  });

  it('sweeps away tokens of people who lost access', async () => {
    const { store } = makeStore();
    const alice = store.createPersonal(ALICE, 'a', 30);
    const bob = store.createPersonal(BOB, 'b', 30);
    const sweep = startAccessSweep(
      store,
      async (login) => (login === 'bob' ? 'denied' : 'unknown'),
      { log: silentLog, intervalMs: 60_000 },
    );
    expect(await sweep.runOnce()).toBe(1);
    sweep.stop();
    expect(store.verify(alice.token)).toBeDefined();
    expect(store.verify(bob.token)).toBeUndefined();
  });
});
