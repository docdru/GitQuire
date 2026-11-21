import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddableRepo, BotAccess, DoorHost, HostRepo, RepoAccess } from '../host/types.ts';
import { ACCESS_TTL_MS, createWikiAccess } from './access.ts';
import type { AllowedOwners } from './allowed-owners.ts';
import { createFrontDoor, type FrontDoor } from './server.ts';
import type { FrontDoorSettings } from './settings.ts';
import { createWikiProcesses, type WikiProcesses } from './wiki-processes.ts';
import { openWikiTable, type WikiTable } from './wiki-table.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const CHILD = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.url === '/readyz') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/api/gitquire/stop-state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pushedAndClean: true }));
    return;
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/somewhere', 'x-gitquire-view': 'd1', 'set-cookie': 'gq_view=d1; Path=/' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ repo: process.env.GITQUIRE_REPO, url: req.url, headers: req.headers }));
});
server.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');
  socket.on('data', (chunk) => socket.write(chunk));
});
const socket = process.env.GITQUIRE_SOCKET;
server.listen(socket);
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
`;

const repoA = { host: 'github' as const, id: 1, owner: 'team', ownerId: 7, name: 'a' };
const repoB = { host: 'github' as const, id: 2, owner: 'team', ownerId: 7, name: 'b' };
const repoC = { host: 'github' as const, id: 3, owner: 'team', ownerId: 7, name: 'c' };
const repoD = { host: 'github' as const, id: 4, owner: 'other', ownerId: 9, name: 'd' };

const people: Record<string, { id: number; login: string; name: string; avatarUrl: string }> = {
  'token-alice': { id: 11, login: 'alice', name: 'Alice', avatarUrl: '' },
  'token-bob': { id: 12, login: 'bob', name: 'Bob', avatarUrl: '' },
};

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Rig {
  base: string;
  door: FrontDoor;
  table: WikiTable;
  processes: WikiProcesses;
  levels: Record<string, Record<string, RepoAccess>>;
  bot: { answer: BotAccess | undefined };
  advance: (ms: number) => void;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-door-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function rig(options: { host?: 'github' | 'forgejo' } = {}): Promise<Rig> {
  const data = tempDir();
  const script = join(tempDir(), 'child.cjs');
  writeFileSync(script, CHILD);
  let time = Date.UTC(2026, 10, 21);
  const levels: Rig['levels'] = {
    alice: { a: 'admin', b: 'write', c: 'admin' },
    bob: { a: 'write', b: 'none' },
  };
  const bot: Rig['bot'] = { answer: undefined };
  const host: DoorHost = {
    authorizeUrl: ({ state }) => `https://host.example/authorize?state=${state}`,
    exchangeCode: async ({ code }) => `token-${code}`,
    person: async (token) => people[token],
    access: async (token, repo) => levels[people[token]?.login ?? '']?.[repo.name] ?? 'none',
    accessByBot: async (login, repo) => bot.answer ?? levels[login]?.[repo.name] ?? 'none',
    addableRepos: async () => ({
      state: 'listed',
      repos: [repoA, repoC, repoD] as AddableRepo[],
    }),
    repoById: async (id) => {
      const found = [repoA, repoB, repoC, repoD].find((r) => r.id === id);
      return found === undefined ? { state: 'gone' } : { state: 'found', repo: found };
    },
    health: async () => 'ok',
    tokenFor: async () => 'tok',
    selfCheck: async () => ({ ok: true }),
  };
  const table = openWikiTable(join(data, 'server', 'wikis.json'));
  table.add(repoA, 'alice', time);
  table.add(repoB, 'alice', time);
  const owners: AllowedOwners = {
    names: new Set(['team']),
    pinned: table.ownerIds,
    pin: table.pinOwner,
  };
  const settings: FrontDoorSettings = {
    host: options.host ?? 'github',
    dataDir: data,
    externalUrl: new URL('http://127.0.0.1'),
    clientId: 'id',
    clientSecret: 'secret',
    sessionSecret: '0123456789abcdef0123456789abcdef',
    sessionMaxAgeSeconds: 3600,
    webUrl: 'https://host.example',
    apiUrl: 'https://host.example/api',
    defaultWiki: { owner: 'team', name: 'a' },
    allowedOwners: owners.names,
    serverAdmins: new Set(['alice']),
    githubApp: undefined,
    forgejoBotToken: undefined,
  };
  const now = () => time;
  const access = createWikiAccess({
    host,
    runnable: () => true,
    refused: (wiki, refusal) => table.disconnect(wiki.key, refusal),
    now,
  });
  const processes = createWikiProcesses({
    dataDir: data,
    externalUrl: settings.externalUrl,
    env: { PATH: process.env.PATH, GITHUB_APP_PRIVATE_KEY: 'key' },
    cli: [process.execPath, script],
    host,
    table,
    owners,
    tokenSocket: () => '/tmp/none.sock',
    log: silentLog,
    bootstrap: async () => {},
    now,
  });
  cleanup.push(() => processes.stopAll());
  const saved: Record<string, string> = {};
  const door = createFrontDoor({
    settings,
    host,
    table,
    owners,
    access,
    processes,
    forgejoTokens:
      options.host === 'forgejo'
        ? {
            check: async (_repo: HostRepo, token: string) =>
              token === 'good' ? 'ok' : 'refused:token',
            save: (key, token) => {
              saved[key] = token;
            },
            isBotToken: (token) => token === 'bot',
          }
        : undefined,
    addWikiHelp: async () =>
      options.host === 'forgejo'
        ? { botLogin: 'gq-bot' }
        : { installUrl: 'https://github.com/apps/gq/installations/new' },
    log: silentLog,
    now,
    randomState: () => 'state-1',
  });
  door.setReady(true);
  const server: Server = createServer(door.handleRequest);
  server.on('upgrade', door.handleUpgrade);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  settings.externalUrl = new URL(`http://127.0.0.1:${port}`);
  return {
    base: `http://127.0.0.1:${port}`,
    door,
    table,
    processes,
    levels,
    bot,
    advance: (ms) => {
      time += ms;
    },
  };
}

interface Answer {
  status: number;
  headers: { get: (name: string) => string | null; getSetCookie: () => string[] };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function httpFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: string;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (name) => {
              const value = res.headers[name.toLowerCase()];
              return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value;
            },
            getSetCookie: () => res.headers['set-cookie'] ?? [],
          },
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
    sent.on('error', reject);
    sent.end(init.body);
  });
}

function cookiesOf(response: Answer): string[] {
  return response.headers.getSetCookie().map((line) => line.split(';')[0] ?? '');
}

async function signIn(r: Rig, who: string, path = '/auth/github/login?next=%2F'): Promise<string> {
  const first = path.includes('add-wiki') ? await signIn(r, who) : '';
  const start = await httpFetch(`${r.base}${path}`, {
    redirect: 'manual',
    headers: { cookie: first },
  });
  const state = cookiesOf(start).find((c) => c.startsWith('gq_oauth_state='));
  const back = await httpFetch(`${r.base}/auth/github/callback?code=${who}&state=state-1`, {
    redirect: 'manual',
    headers: { cookie: state ?? '' },
  });
  expect(back.status).toBe(302);
  const session = cookiesOf(back).find((c) => c.startsWith('gq_session=') && c !== 'gq_session=');
  expect(session).toBeDefined();
  return session ?? '';
}

async function get(r: Rig, path: string, cookie: string, headers: Record<string, string> = {}) {
  return httpFetch(`${r.base}${path}`, { redirect: 'manual', headers: { cookie, ...headers } });
}

function principal(echo: { headers: Record<string, string> }): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(echo.headers['x-gitquire-principal'] ?? '', 'base64url').toString(),
  );
}

describe('front door', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it('answers its own health checks', async () => {
    expect((await httpFetch(`${r.base}/healthz`)).status).toBe(200);
    expect((await httpFetch(`${r.base}/readyz`)).status).toBe(200);
    r.door.setReady(false);
    expect((await httpFetch(`${r.base}/readyz`)).status).toBe(503);
  });

  it('sends a signed-out browser to sign-in at the root, with the state cookie at the root', async () => {
    const page = await get(r, '/w/team/a/page', '', { accept: 'text/html' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/auth/github/login?next=%2Fw%2Fteam%2Fa%2Fpage');
    const start = await httpFetch(`${r.base}/auth/github/login?next=/w/team/a/`, {
      redirect: 'manual',
    });
    expect(start.headers.getSetCookie()[0]).toMatch(/^gq_oauth_state=.*; Path=\//);
    const api = await get(r, '/w/team/a/api/x', '');
    expect(api.status).toBe(401);
  });

  it('signs in once and opens both wikis, each in its own process with its own secret, prefix and admin flag', async () => {
    const session = await signIn(r, 'alice');
    const a = (await (await get(r, '/w/team/a/page?x=1', session)).json()) as {
      repo: string;
      url: string;
      headers: Record<string, string>;
    };
    const b = (await (await get(r, '/w/team/b/', session)).json()) as typeof a;
    expect(a.repo).toBe('team/a');
    expect(b.repo).toBe('team/b');
    expect(a.url).toBe('/page?x=1');
    expect(a.headers['x-gitquire-prefix']).toBe('/w/team/a');
    expect(b.headers['x-gitquire-prefix']).toBe('/w/team/b');
    expect(a.headers['x-gitquire-internal']).toBe(r.processes.secretOf('github-1'));
    expect(b.headers['x-gitquire-internal']).toBe(r.processes.secretOf('github-2'));
    expect(a.headers['x-gitquire-internal']).not.toBe(b.headers['x-gitquire-internal']);
    expect(principal(a)).toMatchObject({ login: 'alice', repoAdmin: true });
    expect(principal(b)).toMatchObject({ login: 'alice' });
    expect(principal(b).repoAdmin).toBeUndefined();
    expect(a.headers.cookie).toBeUndefined();
  });

  it('gives a person with one wiki "no access" for the other', async () => {
    const session = await signIn(r, 'bob');
    expect((await get(r, '/w/team/a/', session)).status).toBe(200);
    const page = await get(r, '/w/team/b/', session, { accept: 'text/html' });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('does not have write access to <code>team/b</code>');
    const api = await get(r, '/w/team/b/api/x', session);
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: 'no-access' });
    expect(r.processes.isRunning('github-2')).toBe(false);
    const list = (await (await get(r, '/api/front-door/wikis', session)).json()) as {
      wikis: Array<{ name: string }>;
    };
    expect(list.wikis.map((w) => w.name)).toEqual(['a']);
  });

  it('replaces x-gitquire-* headers a browser sends with its own', async () => {
    const session = await signIn(r, 'bob');
    const echo = (await (
      await get(r, '/w/team/a/', session, {
        'x-gitquire-principal': Buffer.from(
          JSON.stringify({ id: 1, login: 'root', repoAdmin: true }),
        ).toString('base64url'),
        'x-gitquire-internal': 'forged',
        'x-gitquire-prefix': '/w/team/b',
        'x-gitquire-view': 'other',
      })
    ).json()) as { headers: Record<string, string> };
    expect(principal(echo)).toMatchObject({ login: 'bob' });
    expect(principal(echo).repoAdmin).toBeUndefined();
    expect(echo.headers['x-gitquire-prefix']).toBe('/w/team/a');
    expect(echo.headers['x-gitquire-view']).toBeUndefined();
    expect(echo.headers['x-gitquire-internal']).toBe(r.processes.secretOf('github-1'));
  });

  it('adds the trailing slash, the prefix to redirects, and keeps the open draft in a per-wiki cookie', async () => {
    const session = await signIn(r, 'alice');
    const bare = await get(r, '/w/team/a?x=1', session);
    expect(bare.status).toBe(302);
    expect(bare.headers.get('location')).toBe('/w/team/a/?x=1');
    const moved = await get(r, '/w/team/a/redirect', session);
    expect(moved.headers.get('location')).toBe('/w/team/a/somewhere');
    expect(cookiesOf(moved)).toEqual(['gq_view_github-1=d1']);
    const echo = (await (
      await get(r, '/w/team/a/', `${session}; gq_view_github-1=d1; gq_view_github-2=d2`)
    ).json()) as { headers: Record<string, string> };
    expect(echo.headers['x-gitquire-view']).toBe('d1');
    const other = (await (
      await get(r, '/w/team/b/', `${session}; gq_view_github-1=d1`)
    ).json()) as {
      headers: Record<string, string>;
    };
    expect(other.headers['x-gitquire-view']).toBeUndefined();
  });

  it('routes a GET without a wiki prefix by its Referer after the access check', async () => {
    const alice = await signIn(r, 'alice');
    const image = (await (
      await get(r, '/dot.png', alice, { referer: `${r.base}/w/team/b/page` })
    ).json()) as { repo: string; url: string };
    expect(image).toMatchObject({ repo: 'team/b', url: '/dot.png' });
    const bob = await signIn(r, 'bob');
    expect((await get(r, '/dot.png', bob, { referer: `${r.base}/w/team/b/page` })).status).toBe(
      403,
    );
    const post = await httpFetch(`${r.base}/dot.png`, {
      method: 'POST',
      headers: { cookie: alice, referer: `${r.base}/w/team/b/page` },
    });
    expect(post.status).toBe(404);
  });

  it('sends old addresses to the default wiki and shows the list at the root', async () => {
    const session = await signIn(r, 'alice');
    const old = await get(r, '/docs/plan', session, { accept: 'text/html' });
    expect(old.headers.get('location')).toBe('/w/team/a/docs/plan');
    const home = await get(r, '/', session, { accept: 'text/html' });
    const html = await home.text();
    expect(html).toContain('href="/w/team/a/"');
    expect(html).toContain('href="/w/team/b/"');
    expect(html).toContain('id="gq-default-wiki" data-address="/w/team/a/"');
    expect(html).toContain('This server hosts wikis from team.');
    expect((await get(r, '/_door/old-address.js', '')).status).toBe(200);
  });

  it('redirects a renamed wiki to its new address and answers an unknown one with the allowed owners', async () => {
    const session = await signIn(r, 'alice');
    r.table.rename('github-2', { owner: 'team', name: 'handbook' });
    const old = await get(r, '/w/team/b/page?x=1', session);
    expect(old.status).toBe(301);
    expect(old.headers.get('location')).toBe('/w/team/handbook/page?x=1');
    const unknown = await get(r, '/w/other/x/', session);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: 'not-a-wiki',
      hosts: 'This server hosts wikis from team.',
    });
  });

  it('makes a wiki only from a fresh host answer, only under an allowed owner, only once (R1, R18)', async () => {
    const session = await signIn(r, 'alice');
    const post = (body: unknown) =>
      httpFetch(`${r.base}/api/front-door/wikis`, {
        method: 'POST',
        headers: { cookie: session, origin: r.base, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ id: 3 })).status).toBe(409);
    expect((await get(r, '/api/front-door/addable', session)).status).toBe(409);
    const added = await signIn(r, 'alice', '/auth/github/add-wiki?next=%2Fadd');
    const addable = (await (await get(r, '/api/front-door/addable', added)).json()) as {
      repos: Array<{ name: string; wiki?: string }>;
      canAdd: boolean;
      needsToken: boolean;
    };
    expect(addable.repos.map((repo) => [repo.name, repo.wiki])).toEqual([
      ['a', '/w/team/a/'],
      ['c', undefined],
    ]);
    expect(addable).toMatchObject({ canAdd: true, needsToken: false });
    expect((await post({ id: 4 })).status).toBe(403);
    expect((await post({ id: 2 })).status).toBe(403);
    expect((await post({ id: 1 })).status).toBe(409);
    const made = await post({ id: 3 });
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({
      wiki: { key: 'github-3', address: '/w/team/c/', admin: true },
    });
    expect(r.table.byKey('github-3')).toMatchObject({ state: 'on', addedBy: 'alice' });
    expect(r.table.ownerIds()).toEqual({ team: 7 });
    const crossSite = await httpFetch(`${r.base}/api/front-door/wikis`, {
      method: 'POST',
      headers: {
        cookie: session,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 3 }),
    });
    expect(crossSite.status).toBe(403);
  });

  it('cuts an open live-editing connection at the re-check after access is lost (R8)', async () => {
    const session = await signIn(r, 'bob');
    const port = Number(new URL(r.base).port);
    const socket = connect(port, '127.0.0.1');
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const opened = new Promise<string>((resolve) =>
      socket.once('data', (chunk) => resolve(String(chunk))),
    );
    socket.write(
      `GET /w/team/a/collab HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${session}\r\n\r\n`,
    );
    expect(await opened).toContain('101 Switching Protocols');
    await r.door.recheckConnections();
    expect(socket.destroyed).toBe(false);
    r.levels.bob = { a: 'none' };
    r.advance(ACCESS_TTL_MS + 1);
    await r.door.recheckConnections();
    await closed;
  });

  it('refuses a websocket without a session or access', async () => {
    const port = Number(new URL(r.base).port);
    const answer = (cookie: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(port, '127.0.0.1');
        socket.once('data', (chunk) => {
          resolve(String(chunk).split('\r\n')[0] ?? '');
          socket.destroy();
        });
        socket.write(
          `GET /w/team/b/collab HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`,
        );
      });
    expect(await answer('')).toBe('HTTP/1.1 401 Unauthorized');
    expect(await answer(await signIn(r, 'bob'))).toBe('HTTP/1.1 403 Forbidden');
  });

  it('keeps people inside while the host is unreachable (R14) and shows admins why a wiki is disconnected (R15)', async () => {
    const alice = await signIn(r, 'alice');
    r.bot.answer = 'unreachable';
    r.advance(ACCESS_TTL_MS + 1);
    expect((await get(r, '/w/team/a/', alice)).status).toBe(200);
    r.bot.answer = 'refused:removed';
    r.advance(ACCESS_TTL_MS + 1);
    expect((await get(r, '/w/team/a/', alice)).status).toBe(403);
    expect(r.table.byKey('github-1')).toMatchObject({ state: 'disconnected', reason: 'removed' });
    const list = (await (await get(r, '/api/front-door/wikis', alice)).json()) as {
      wikis: Array<{ name: string; state: string; reason?: string }>;
    };
    expect(list.wikis.find((w) => w.name === 'a')).toMatchObject({
      state: 'disconnected',
      reason: 'removed',
    });
  });
});

describe('wiki list and Add a wiki pages', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  const postForm = (
    path: string,
    cookie: string,
    fields: Record<string, string>,
    origin = r.base,
  ) =>
    httpFetch(`${r.base}${path}`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
    });

  it('lists only the wikis a person may open, and why a wiki is disconnected only to its admins', async () => {
    const alice = await signIn(r, 'alice');
    const bob = await signIn(r, 'bob');
    r.table.disconnect('github-1', 'removed');
    const mine = await (await get(r, '/', alice, { accept: 'text/html' })).text();
    expect(mine).toContain('<li data-wiki="github-1">team/a <span class="muted">admin</span>');
    expect(mine).toContain('(disconnected)');
    expect(mine).toContain('GitQuire no longer has access to this repository');
    expect(mine).toContain('href="/w/team/b/"');
    expect(mine).toContain('<a href="/add-wiki">Add a wiki</a>');
    expect(mine).toContain('This server hosts wikis from team.');
    const his = await (await get(r, '/', bob, { accept: 'text/html' })).text();
    expect(his).toContain('You have no wikis on this server yet.');
    expect(his).not.toContain('team/a');
    expect(his).not.toContain('team/b');
  });

  it('asks the host again before showing Add a wiki, then lists the repos the person administers', async () => {
    const plain = await signIn(r, 'alice');
    const first = await get(r, '/add-wiki', plain, { accept: 'text/html' });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/auth/github/add-wiki?next=%2Fadd-wiki');
    const session = await signIn(r, 'alice', '/auth/github/add-wiki?next=%2Fadd-wiki');
    const page = await (await get(r, '/add-wiki', session, { accept: 'text/html' })).text();
    expect(page).toContain(
      '<tr data-repo="1"><td><code>team/a</code></td><td><a href="/w/team/a/">',
    );
    expect(page).toContain(
      '<input type="hidden" name="id" value="3"><button type="submit">Make this a wiki</button>',
    );
    expect(page).not.toContain('other/d');
    expect(page).toContain('href="https://github.com/apps/gq/installations/new"');
    expect(page).toContain('This server hosts wikis from team.');
    expect((await postForm('/add-wiki', session, { id: '3' }, 'https://evil.example')).status).toBe(
      403,
    );
    const refused = await postForm('/add-wiki', session, { id: '4' });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('role="alert"');
    const made = await postForm('/add-wiki', session, { id: '3' });
    expect(made.status).toBe(303);
    expect(made.headers.get('location')).toBe('/w/team/c/');
    expect(r.table.byKey('github-3')).toMatchObject({ state: 'on', addedBy: 'alice' });
  });

  it('tells a person at the address of a repo under an allowed owner that it is no wiki yet', async () => {
    const session = await signIn(r, 'alice');
    const yet = await (await get(r, '/w/team/zzz/', session, { accept: 'text/html' })).text();
    expect(yet).toContain('This repository is not a wiki yet.');
    expect(yet).toContain('This server hosts wikis from team.');
    const other = await (await get(r, '/w/other/x/', session, { accept: 'text/html' })).text();
    expect(other).toContain('There is no wiki at this address.');
    expect(other).toContain('This server hosts wikis from team.');
  });

  it('lists the wikis with the Add a wiki page address for the app menu', async () => {
    const session = await signIn(r, 'alice');
    expect(await (await get(r, '/api/front-door/wikis', session)).json()).toMatchObject({
      addWikiPage: '/add-wiki',
      hosts: 'This server hosts wikis from team.',
    });
  });
});

describe('front door on Forgejo', () => {
  it('explains on Add a wiki that the bot must be repo admin and a server administrator enters the token', async () => {
    const r = await rig({ host: 'forgejo' });
    const alice = await signIn(r, 'alice', '/auth/github/add-wiki?next=%2Fadd-wiki');
    const page = await (await get(r, '/add-wiki', alice, { accept: 'text/html' })).text();
    expect(page).toContain('<strong>@gq-bot</strong>');
    expect(page).toContain('make that account an administrator of the repository');
    expect(page).toContain('a server administrator signs in to');
    expect(page).toContain('<input type="password" name="token"');
    const bob = await signIn(r, 'bob', '/auth/github/add-wiki?next=%2Fadd-wiki');
    const his = await (await get(r, '/add-wiki', bob, { accept: 'text/html' })).text();
    expect(his).toContain('A server administrator can add it.');
    expect(his).toContain('only server administrators add wikis');
    expect(his).not.toContain('name="token"');
    const form = (cookie: string, fields: Record<string, string>, path = '/add-wiki') =>
      httpFetch(`${r.base}${path}`, {
        method: 'POST',
        headers: { cookie, origin: r.base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    expect((await form(bob, { id: '3', token: 'good' })).status).toBe(403);
    expect((await form(alice, { id: '3', token: 'wrong' })).status).toBe(400);
    expect((await form(alice, { id: '3', token: 'good' })).headers.get('location')).toBe(
      '/w/team/c/',
    );
    r.table.disconnect('github-1', 'token');
    const home = await (await get(r, '/', alice, { accept: 'text/html' })).text();
    expect(home).toContain('action="/add-wiki/token"');
    expect((await form(bob, { key: 'github-1', token: 'good' }, '/add-wiki/token')).status).toBe(
      403,
    );
    const saved = await form(alice, { key: 'github-1', token: 'good' }, '/add-wiki/token');
    expect(saved.status).toBe(303);
  });

  it('lets only a server administrator add a wiki, with a token that works for the repository (F10)', async () => {
    const r = await rig({ host: 'forgejo' });
    const session = await signIn(r, 'alice', '/auth/github/add-wiki?next=%2F');
    const post = (body: unknown) =>
      httpFetch(`${r.base}/api/front-door/wikis`, {
        method: 'POST',
        headers: { cookie: session, origin: r.base, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ id: 3 })).status).toBe(400);
    expect((await post({ id: 3, token: 'bot' })).status).toBe(400);
    expect(await (await post({ id: 3, token: 'wrong' })).json()).toMatchObject({
      error: 'token-refused',
    });
    expect((await post({ id: 3, token: 'good' })).status).toBe(201);
    const bob = await signIn(r, 'bob', '/auth/github/add-wiki?next=%2F');
    const answer = (await (await get(r, '/api/front-door/addable', bob)).json()) as {
      canAdd: boolean;
    };
    expect(answer.canAdd).toBe(false);
  });
});
