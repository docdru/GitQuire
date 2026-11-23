import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_KEY_SECRET_ENV, deriveChatKeySecret } from '../chat/key-secret.ts';
import type { DoorHost, HostHealth, RepoLookup } from '../host/types.ts';
import type { AllowedOwners } from './allowed-owners.ts';
import { createWikiProcesses, WIKI_IDLE_MS, WikiClosedError, wikiEnv } from './wiki-processes.ts';
import { openWikiTable, type WikiRecord } from './wiki-table.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const CHILD = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.url === '/api/gitquire/stop-state') {
    const ok = req.headers['x-gitquire-internal'] === process.env.GITQUIRE_INTERNAL_SECRET;
    res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pushedAndClean: !require('node:fs').existsSync('DIRTY') }));
    return;
  }
  res.writeHead(200);
  res.end('ok');
});
const socket = process.env.GITQUIRE_SOCKET;
server.listen(socket);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-wikis-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const repo = { host: 'github' as const, id: 5, owner: 'team', ownerId: 7, name: 'wiki' };

function record(): WikiRecord {
  return { ...repo, key: 'github-5', state: 'on', formerNames: [], addedBy: 'a', addedAt: '' };
}

describe('wiki process environment (R12)', () => {
  it('passes only the settings a wiki needs, with its own repo, address, secret and token socket', () => {
    const env = wikiEnv(
      {
        PATH: '/bin',
        HOME: '/home/gq',
        NODE_EXTRA_CA_CERTS: '/ca.pem',
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'key',
        GITHUB_APP_CLIENT_SECRET: 'oauth',
        GITQUIRE_HOST_TOKEN: 'bot',
        GITQUIRE_HOST_TOKEN_FILE: '/run/bot',
        GITQUIRE_HOST_REPO_TOKEN: 'limited',
        GITQUIRE_HOST_CLIENT_SECRET: 'oauth',
        GITQUIRE_SESSION_SECRET: 'session',
        GITQUIRE_WIKIS: 'on',
        GITQUIRE_ALLOWED_OWNERS: 'team',
        GITQUIRE_REPO: 'team/other',
        GITQUIRE_DRAFTS_DIR: '/data/drafts',
        GITQUIRE_MCP_CONNECTORS: 'on',
        GITQUIRE_INTERNAL_SECRET: 'front-door-secret',
        PORT: '8080',
        NODE_OPTIONS: '--require /tmp/x.js',
        LD_PRELOAD: '/tmp/x.so',
        LC_ALL: 'C.UTF-8',
        HTTPS_PROXY: 'http://proxy:3128',
        SOMETHING_ELSE: 'x',
        GITQUIRE_HOST: 'forgejo',
        GITQUIRE_HOST_URL: 'https://code.example.org',
        GITQUIRE_AI_CHAT: 'off',
        GITQUIRE_ADMINS: 'alice',
      },
      record(),
      {
        externalUrl: new URL('https://wiki.example.org'),
        secret: 's'.repeat(64),
        tokenSocket: '/tmp/d/door.sock',
      },
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/gq',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      LC_ALL: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      GITQUIRE_HOST: 'forgejo',
      GITQUIRE_HOST_URL: 'https://code.example.org',
      GITQUIRE_AI_CHAT: 'off',
      GITQUIRE_ADMINS: 'alice',
      GITQUIRE_BEHIND_FRONT_DOOR: 'on',
      GITQUIRE_REPO: 'team/wiki',
      GITQUIRE_REPO_ID: '5',
      GITQUIRE_EXTERNAL_URL: 'https://wiki.example.org/w/team/wiki',
      GITQUIRE_ALLOW_EXTERNAL: '1',
      GITQUIRE_BIND: '127.0.0.1',
      GITQUIRE_INTERNAL_SECRET: 's'.repeat(64),
      GITQUIRE_DOOR_TOKEN_SOCKET: '/tmp/d/door.sock',
    });
  });
});

describe('AI chat key inside a wiki', () => {
  const base = { PATH: '/bin', GITQUIRE_SESSION_SECRET: 'x'.repeat(40) };
  const options = {
    externalUrl: new URL('https://wiki.example.org'),
    secret: 's'.repeat(64),
    tokenSocket: '/tmp/d/door.sock',
  };

  it('passes a key derived for this wiki, never the session secret', () => {
    const env = wikiEnv(base, record(), options);
    const other = wikiEnv(base, { ...record(), key: 'github-6', id: 6 }, options);
    expect(env.GITQUIRE_SESSION_SECRET).toBeUndefined();
    expect(env[CHAT_KEY_SECRET_ENV]).toBe(deriveChatKeySecret('x'.repeat(40), 'github-5'));
    expect(env[CHAT_KEY_SECRET_ENV]).toMatch(/^[0-9a-f]{64}$/);
    expect(other[CHAT_KEY_SECRET_ENV]).not.toBe(env[CHAT_KEY_SECRET_ENV]);
    expect(Object.values(env)).not.toContain('x'.repeat(40));
  });

  it('passes no key when AI chat is off', () => {
    const env = wikiEnv({ ...base, GITQUIRE_AI_CHAT: 'off' }, record(), options);
    expect(env[CHAT_KEY_SECRET_ENV]).toBeUndefined();
  });
});

function setup(options: { dirty?: boolean; lookup?: RepoLookup; health?: HostHealth } = {}) {
  const data = tempDir();
  const script = join(tempDir(), 'child.cjs');
  writeFileSync(script, CHILD);
  const table = openWikiTable(join(data, 'server', 'wikis.json'));
  const wiki = table.add(repo, 'alice', 0);
  const owners: AllowedOwners = {
    names: new Set(['team']),
    pinned: table.ownerIds,
    pin: table.pinOwner,
  };
  let time = 1_000_000;
  const answers = {
    lookup: options.lookup ?? ({ state: 'found', repo } as RepoLookup),
    health: options.health ?? ('ok' as HostHealth),
  };
  const host: Pick<DoorHost, 'repoById' | 'health'> = {
    repoById: async () => answers.lookup,
    health: async () => answers.health,
  };
  const bootstrapped: string[] = [];
  const processes = createWikiProcesses({
    dataDir: data,
    externalUrl: new URL('https://wiki.example.org'),
    env: { PATH: process.env.PATH },
    cli: [process.execPath, script],
    host,
    table,
    owners,
    tokenSocket: () => '/tmp/door.sock',
    log: silentLog,
    bootstrap: async (dir) => {
      bootstrapped.push(dir);
      if (options.dirty) writeFileSync(join(dir, 'DIRTY'), '');
    },
    now: () => time,
  });
  cleanup.push(() => processes.stopAll());
  return {
    data,
    table,
    wiki,
    processes,
    answers,
    bootstrapped,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('wiki processes', () => {
  it('sets up the folder /data/wikis/<host>-<id>/ and starts the wiki on its socket', async () => {
    const { data, wiki, processes, bootstrapped } = setup();
    const socket = await processes.ensure(wiki);
    expect(socket.endsWith('github-5.sock')).toBe(true);
    expect(bootstrapped).toEqual([join(data, 'wikis', 'github-5')]);
    expect(existsSync(join(data, 'wikis', 'github-5'))).toBe(true);
    expect(processes.secretOf('github-5')).toMatch(/^[0-9a-f]{64}$/);
    expect(processes.wikiOfSecret(processes.secretOf('github-5') ?? '')).toBe('github-5');
    expect(processes.wikiOfSecret('x')).toBeUndefined();
  });

  it('stops an idle wiki only when it says it is pushed and clean (R6)', async () => {
    const clean = setup();
    await clean.processes.ensure(clean.wiki);
    await clean.processes.sweep();
    expect(clean.processes.isRunning('github-5')).toBe(true);
    clean.advance(WIKI_IDLE_MS + 1);
    await clean.processes.sweep();
    expect(clean.processes.isRunning('github-5')).toBe(false);

    const dirty = setup({ dirty: true });
    await dirty.processes.ensure(dirty.wiki);
    dirty.advance(WIKI_IDLE_MS + 1);
    await dirty.processes.sweep();
    expect(dirty.processes.isRunning('github-5')).toBe(true);
  });

  it('keeps a wiki with an open live-editing connection running', async () => {
    const { wiki, processes, advance } = setup();
    await processes.ensure(wiki);
    const release = processes.hold('github-5');
    advance(WIKI_IDLE_MS + 1);
    await processes.sweep();
    expect(processes.isRunning('github-5')).toBe(true);
    release();
    advance(WIKI_IDLE_MS + 1);
    await processes.sweep();
    expect(processes.isRunning('github-5')).toBe(false);
  });

  it('follows a rename, and stops a renamed wiki once it is pushed and clean so it restarts under the new name (R10)', async () => {
    const { table, wiki, processes, answers } = setup();
    await processes.ensure(wiki);
    answers.lookup = { state: 'found', repo: { ...repo, name: 'handbook' } };
    expect(await processes.check(wiki)).toBe('runnable');
    expect(table.byKey('github-5')).toMatchObject({
      name: 'handbook',
      formerNames: [{ owner: 'team', name: 'wiki' }],
    });
    await processes.sweep();
    expect(processes.isRunning('github-5')).toBe(false);
  });

  it('disconnects a wiki moved to an owner that is not allowed and does not start it (R18, R11)', async () => {
    const { table, wiki, processes } = setup({
      lookup: { state: 'found', repo: { ...repo, owner: 'other', ownerId: 9 } },
    });
    await expect(processes.ensure(wiki)).rejects.toBeInstanceOf(WikiClosedError);
    expect(table.byKey('github-5')).toMatchObject({
      state: 'disconnected',
      reason: 'owner-not-allowed',
    });
    expect(table.list()).toHaveLength(1);
  });

  it('disconnects on a refused token or a removed app, and reconnects when the host answers again (R15)', async () => {
    const { table, wiki, processes, answers } = setup({ health: 'refused:removed' });
    expect(await processes.check(wiki)).toBe('closed');
    expect(table.byKey('github-5')).toMatchObject({ state: 'disconnected', reason: 'removed' });
    answers.health = 'unreachable';
    expect(await processes.check(wiki)).toBe('closed');
    answers.health = 'ok';
    expect(await processes.check(wiki)).toBe('runnable');
    expect(table.byKey('github-5')?.state).toBe('on');
    answers.lookup = { state: 'gone' };
    expect(await processes.check(wiki)).toBe('closed');
    expect(table.byKey('github-5')?.reason).toBe('gone');
  });

  it('starts a wiki while the host is unreachable once its owner was confirmed by id (R14)', async () => {
    const { table, wiki, processes } = setup({ lookup: { state: 'unreachable' } });
    expect(await processes.check(wiki)).toBe('unreachable');
    await expect(processes.ensure(wiki)).rejects.toThrow(/never confirmed/);
    expect(processes.isRunning('github-5')).toBe(false);
    table.pinOwner('team', 7);
    await expect(processes.ensure(wiki)).resolves.toContain('github-5.sock');
  });

  it('forgets the secret of a wiki whose process has stopped', async () => {
    const { wiki, processes, advance } = setup();
    await processes.ensure(wiki);
    const secret = processes.secretOf('github-5') ?? '';
    expect(processes.wikiOfSecret(secret)).toBe('github-5');
    advance(WIKI_IDLE_MS + 1);
    await processes.sweep();
    expect(processes.isRunning('github-5')).toBe(false);
    expect(processes.secretOf('github-5')).toBeUndefined();
    expect(processes.wikiOfSecret(secret)).toBeUndefined();
  });
});
