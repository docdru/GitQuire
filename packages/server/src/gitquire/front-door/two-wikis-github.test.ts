import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeCommentTimes,
  writeCommentThreads,
} from '@gitquire/core/gitquire/comment-threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFrontDoor } from './start.ts';
import { openWikiTable, wikiTableFile } from './wiki-table.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const EDITOR = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('gitquire-bootstrap')) {
  fs.writeFileSync(path.join(process.argv[process.argv.length - 1], 'bootstrapped'), process.env.GITQUIRE_REPO);
  process.exit(0);
}
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  if (req.url === '/readyz') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/api/gitquire/stop-state') {
    json(res, 200, { pushedAndClean: !fs.existsSync('unpushed') });
    return;
  }
  if (req.url === '/api/gitquire/drafts/open') {
    json(res, 200, { opened: 'd1' }, { 'x-gitquire-view': 'd1' });
    return;
  }
  json(res, 200, { repo: process.env.GITQUIRE_REPO, pid: process.pid, url: req.url, headers: req.headers });
});
server.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');
  socket.on('data', (chunk) => socket.write(chunk));
});
const socket = process.env.GITQUIRE_SOCKET;
server.listen(socket);
process.on('SIGTERM', () => {
  if (fs.existsSync('unpushed')) fs.renameSync('unpushed', 'pushed-on-stop');
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
`;

interface FakeRepo {
  id: number;
  owner: string;
  ownerId: number;
  name: string;
  installed: boolean;
}

interface FakeGitHub {
  url: string;
  repos: FakeRepo[];
  levels: Record<string, Record<number, 'admin' | 'write' | 'none'>>;
  down: boolean;
  close: () => Promise<void>;
}

const users: Record<string, { id: number; login: string }> = {
  alice: { id: 11, login: 'alice' },
  bob: { id: 12, login: 'bob' },
  carol: { id: 13, login: 'carol' },
};

function repoBody(repo: FakeRepo, level?: string) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: true,
    owner: { login: repo.owner, id: repo.ownerId },
    default_branch: 'main',
    ...(level === undefined
      ? {}
      : {
          permissions: {
            admin: level === 'admin',
            maintain: false,
            push: level !== 'none',
            pull: true,
          },
        }),
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

async function fakeGitHub(): Promise<FakeGitHub> {
  const fake: Omit<FakeGitHub, 'url' | 'close'> = {
    repos: [
      { id: 1, owner: 'team', ownerId: 7, name: 'a', installed: true },
      { id: 2, owner: 'team', ownerId: 7, name: 'b', installed: true },
      { id: 4, owner: 'other', ownerId: 9, name: 'd', installed: true },
    ],
    levels: {
      alice: { 1: 'admin', 2: 'admin', 4: 'admin' },
      bob: { 1: 'write', 2: 'none', 4: 'none' },
      carol: {},
    },
    down: false,
  };
  const byName = (owner: string, name: string) =>
    fake.repos.find(
      (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name,
    );
  const server: Server = createServer((req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (fake.down) {
      send(503, { message: 'down' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const person = auth.startsWith('person-') ? users[auth.slice('person-'.length)] : undefined;
    const repoAt = (segments: string[]): FakeRepo | undefined =>
      segments[0] === 'repositories'
        ? fake.repos.find((r) => r.id === Number(segments[1]))
        : byName(segments[1] ?? '', segments[2] ?? '');
    void (async () => {
      const body = await readBody(req);
      if (path === '/login/oauth/access_token') {
        send(200, { access_token: `person-${(body as { code: string }).code}` });
        return;
      }
      if (path === '/user') {
        if (person === undefined) send(401);
        else send(200, { ...person, name: person.login, avatar_url: '' });
        return;
      }
      if (path === '/app') {
        send(200, { slug: 'gitquire', html_url: 'https://github.example/apps/gitquire' });
        return;
      }
      if (path === '/app/installations') {
        send(200, [{ id: 1 }]);
        return;
      }
      if (path === '/app/installations/1/access_tokens' && req.method === 'POST') {
        const wanted = body as { repository_ids?: number[]; repositories?: string[] };
        const repos = wanted.repository_ids
          ? wanted.repository_ids.map((id) => fake.repos.find((r) => r.id === id))
          : (wanted.repositories ?? []).map((name) => fake.repos.find((r) => r.name === name));
        if (repos.some((r) => r === undefined || !r.installed)) {
          send(422, { message: 'not accessible to the installation' });
          return;
        }
        send(201, {
          token: `inst-${repos.map((r) => r?.id).join('-')}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
        return;
      }
      if (path === '/user/installations') {
        send(200, { total_count: 1, installations: [{ id: 1 }] });
        return;
      }
      if (path === '/user/installations/1/repositories' && person !== undefined) {
        const visible = fake.repos.filter(
          (r) => r.installed && (fake.levels[person.login]?.[r.id] ?? 'none') !== 'none',
        );
        send(200, {
          total_count: visible.length,
          repositories: visible.map((r) => repoBody(r, fake.levels[person.login]?.[r.id])),
        });
        return;
      }
      const segments = path.split('/').filter((s) => s !== '');
      const start = segments[0] === 'repositories' ? 2 : 3;
      const repo = repoAt(segments);
      const rest = segments.slice(start);
      if (repo === undefined) {
        send(404, { message: 'Not Found' });
        return;
      }
      if (rest.length === 1 && rest[0] === 'installation') {
        if (repo.installed) send(200, { id: 1 });
        else send(404, { message: 'Not Found' });
        return;
      }
      if (rest.length === 3 && rest[0] === 'collaborators' && rest[2] === 'permission') {
        if (!auth.startsWith('inst-')) {
          send(403, { message: 'Resource not accessible by integration' });
          return;
        }
        if (!repo.installed) {
          send(401, { message: 'Bad credentials' });
          return;
        }
        const level = fake.levels[rest[1] ?? '']?.[repo.id] ?? 'none';
        send(200, { permission: level === 'none' ? 'read' : level, role_name: level });
        return;
      }
      if (rest.length === 0) {
        if (person !== undefined) {
          const level = fake.levels[person.login]?.[repo.id] ?? 'none';
          if (level === 'none') send(404, { message: 'Not Found' });
          else send(200, repoBody(repo, level));
          return;
        }
        if (auth.startsWith('inst-')) {
          if (repo.installed) send(200, repoBody(repo));
          else send(401, { message: 'Bad credentials' });
          return;
        }
        send(404, { message: 'Not Found' });
        return;
      }
      send(404, { message: 'Not Found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

interface Answer {
  status: number;
  location: string | null;
  cookies: string[];
  body: string;
}

function send(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          location: (res.headers.location as string | undefined) ?? null,
          cookies: (res.headers['set-cookie'] ?? []).map((line) => line.split(';')[0] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    sent.on('error', reject);
    sent.end(init.body);
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === 'object' && address !== null ? address.port : 0;
}

async function until<T>(probe: () => Promise<T>, done: (value: T) => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  let last = await probe();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await probe();
  }
  return last;
}

const SECRET = '0123456789abcdef0123456789abcdef';

function mentionPage(threadId: string, mentioned: string): string {
  const comment = normalizeCommentTimes({
    id: `${threadId}-1`,
    author: { id: 'github-11', login: 'alice' },
    createdAt: '2026-11-20T09:00:00.000Z',
    body: `Please look, @${mentioned}`,
    mentions: [mentioned],
  });
  return writeCommentThreads('The quarterly numbers look good.\n', [
    { id: threadId, anchor: { exact: 'quarterly numbers' }, resolved: false, comments: [comment] },
  ]);
}

describe('two wikis behind the front door with the GitHub adapter and a fake GitHub', () => {
  let github: FakeGitHub;
  let data: string;
  let script: string;
  let base: string;
  let port: number;
  let env: Record<string, string>;
  let door: Awaited<ReturnType<typeof startFrontDoor>> | undefined;
  const sessions: Record<string, string> = {};
  const keepDirs: string[] = [];

  async function startDoor(extra: Record<string, string> = {}): Promise<void> {
    door = await startFrontDoor(
      data,
      { ...env, ...extra },
      {
        log: silentLog,
        cli: [process.execPath, script],
      },
    );
  }

  async function stopDoor(): Promise<void> {
    await door?.stop();
    door = undefined;
  }

  async function signIn(who: string, path = '/auth/github/login?next=%2F'): Promise<Answer> {
    const start = await send(`${base}${path}`, { headers: { cookie: sessions[who] ?? '' } });
    const state = new URL(start.location ?? '', 'http://x').searchParams.get('state') ?? '';
    const back = await send(`${base}/auth/github/callback?code=${who}&state=${state}`, {
      headers: { cookie: start.cookies.join('; ') },
    });
    const session = back.cookies.find((c) => c.startsWith('gq_session=') && c !== 'gq_session=');
    if (session !== undefined) sessions[who] = session;
    return back;
  }

  function get(who: string, path: string, headers: Record<string, string> = {}) {
    return send(`${base}${path}`, { headers: { cookie: sessions[who] ?? '', ...headers } });
  }

  function echo(answer: Answer): { repo: string; pid: number; headers: Record<string, string> } {
    expect(answer.status).toBe(200);
    return JSON.parse(answer.body);
  }

  function upgrade(who: string, path: string): Promise<{ line: string; socket: Socket }> {
    return new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('data', (chunk) =>
        resolve({ line: String(chunk).split('\r\n')[0] ?? '', socket }),
      );
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${sessions[who] ?? ''}\r\n\r\n`,
      );
    });
  }

  beforeAll(async () => {
    github = await fakeGitHub();
    data = mkdtempSync(join(tmpdir(), 'gq-two-wikis-'));
    keepDirs.push(data);
    const scriptDir = mkdtempSync(join(tmpdir(), 'gq-two-wikis-editor-'));
    keepDirs.push(scriptDir);
    script = join(scriptDir, 'editor.cjs');
    writeFileSync(script, EDITOR);
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GITQUIRE_HOSTS: 'github',
      GITQUIRE_HOST_GITHUB_CLIENT_ID: 'client',
      GITQUIRE_HOST_GITHUB_CLIENT_SECRET: 'client-secret',
      GITQUIRE_HOST_GITHUB_APP_ID: '5',
      GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY: privateKey
        .export({ type: 'pkcs1', format: 'pem' })
        .toString(),
      GITQUIRE_HOST_GITHUB_URL: github.url,
      GITQUIRE_HOST_GITHUB_API_URL: github.url,
      GITQUIRE_SESSION_SECRET: SECRET,
      GITQUIRE_EXTERNAL_URL: base,
      GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS: 'team',
      GITQUIRE_HOST_GITHUB_ADMINS: 'alice',
      GITQUIRE_ACCESS_CHECK_SECONDS: '1',
      GITQUIRE_WIKI_IDLE_MINUTES: '0.03',
      PORT: String(port),
      GITQUIRE_BIND: '127.0.0.1',
    };
    await startDoor();
  }, 30_000);

  afterAll(async () => {
    await stopDoor();
    await github.close();
    for (const dir of keepDirs) rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('signs alice in once, and she makes both repositories wikis', async () => {
    expect((await signIn('alice')).status).toBe(302);
    expect((await signIn('alice', '/auth/github/add-wiki?next=%2F')).status).toBe(302);
    const addable = JSON.parse((await get('alice', '/api/front-door/addable')).body) as {
      repos: Array<{ name: string }>;
    };
    expect(addable.repos.map((r) => r.name).sort()).toEqual(['a', 'b']);
    for (const id of [1, 2]) {
      const made = await send(`${base}/api/front-door/wikis`, {
        method: 'POST',
        headers: { cookie: sessions.alice ?? '', origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      expect(made.status).toBe(201);
    }
    const a = echo(await get('alice', '/w/github/team/a/page'));
    const b = echo(await get('alice', '/w/github/team/b/page'));
    expect([a.repo, b.repo]).toEqual(['team/a', 'team/b']);
    expect(a.pid).not.toBe(b.pid);
    expect(a.headers['x-gitquire-internal']).not.toBe(b.headers['x-gitquire-internal']);
    expect(readFileSync(join(data, 'wikis', 'github-1', 'bootstrapped'), 'utf8')).toBe('team/a');
    expect(readFileSync(join(data, 'wikis', 'github-2', 'bootstrapped'), 'utf8')).toBe('team/b');
  }, 30_000);

  it('lists each person their own wikis only', async () => {
    expect((await signIn('bob')).status).toBe(302);
    const names = async (who: string) =>
      (
        JSON.parse((await get(who, '/api/front-door/wikis')).body) as {
          wikis: Array<{ name: string }>;
        }
      ).wikis
        .map((w) => w.name)
        .sort();
    expect(await names('alice')).toEqual(['a', 'b']);
    expect(await names('bob')).toEqual(['a']);
    writeFileSync(join(data, 'wikis', 'github-1', 'report.md'), mentionPage('c-a', 'bob'));
    writeFileSync(join(data, 'wikis', 'github-2', 'secret.md'), mentionPage('c-b', 'bob'));
    writeFileSync(join(data, 'wikis', 'github-2', 'other.md'), mentionPage('c-c', 'bob'));
    const counted = await until(
      async () =>
        JSON.parse((await get('bob', '/api/front-door/wikis')).body) as {
          unread: number;
          wikis: Array<{ key: string; unread?: number }>;
        },
      (answer) => answer.unread > 0,
    );
    expect(counted.unread).toBe(1);
    expect(counted.wikis.map((w) => [w.key, w.unread])).toEqual([['github-1', 1]]);
    expect(JSON.stringify(counted)).not.toContain('github-2');
    const page = await get('bob', '/', { accept: 'text/html' });
    expect(page.body).toContain('/w/github/team/a/');
    expect(page.body).not.toContain('team/b');
  }, 30_000);

  it('keeps bob, with wiki a only, out of wiki b by every address', async () => {
    const notAWiki = await get('bob', '/w/github/team/b/page');
    expect(notAWiki.status).toBe(404);
    expect(notAWiki.body).not.toContain('"b"');
    const html = await get('bob', '/w/github/team/b/', { accept: 'text/html' });
    expect(html.status).toBe(404);
    expect(html.body).not.toContain('team/b');
    expect((await get('bob', '/w/github/team/b/image.png')).status).toBe(404);
    expect((await get('bob', '/w/TEAM/B/api/gitquire/drafts')).status).toBe(404);
    expect((await get('bob', '/w/github/team/b/api/gitquire/drafts/open')).status).toBe(404);
    const viaReferer = await get('bob', '/image.png', { referer: `${base}/w/github/team/b/page` });
    expect(viaReferer.status).toBe(404);
    const ownReferer = echo(
      await get('bob', '/image.png', { referer: `${base}/w/github/team/a/page` }),
    );
    expect(ownReferer.repo).toBe('team/a');
    const ws = await upgrade('bob', '/w/github/team/b/collab');
    expect(ws.line).toBe('HTTP/1.1 404 Not Found');
    ws.socket.destroy();
    const own = await upgrade('bob', '/w/github/team/a/collab');
    expect(own.line).toBe('HTTP/1.1 101 Switching Protocols');
    own.socket.destroy();
    const forged = echo(
      await get('bob', '/w/github/team/a/page', {
        'x-gitquire-principal': 'forged',
        'x-gitquire-prefix': '/w/github/team/b',
        cookie: `${sessions.bob}; gq_view_github-2=d1`,
      }),
    );
    expect(forged.headers['x-gitquire-prefix']).toBe('/w/github/team/a');
    expect(forged.headers['x-gitquire-view']).toBeUndefined();
    expect(
      JSON.parse(Buffer.from(forged.headers['x-gitquire-principal'] ?? '', 'base64url').toString()),
    ).toMatchObject({ login: 'bob' });
  }, 30_000);

  it('keeps an open draft to its own wiki', async () => {
    const opened = await get('alice', '/w/github/team/a/api/gitquire/drafts/open');
    const view = opened.cookies.find((c) => c.startsWith('gq_view_github-1='));
    expect(view).toBeDefined();
    const cookie = `${sessions.alice}; ${view}`;
    expect(
      echo(await get('alice', '/w/github/team/a/page', { cookie })).headers['x-gitquire-view'],
    ).toBe('d1');
    expect(
      echo(await get('alice', '/w/github/team/b/page', { cookie })).headers['x-gitquire-view'],
    ).toBeUndefined();
  }, 30_000);

  it('cuts bob off an open live-editing connection once his access is removed (R8)', async () => {
    const live = await upgrade('bob', '/w/github/team/a/collab');
    expect(live.line).toBe('HTTP/1.1 101 Switching Protocols');
    const closed = new Promise<number>((resolve) => {
      const started = Date.now();
      live.socket.once('close', () => resolve(Date.now() - started));
    });
    github.levels.bob = { 1: 'none' };
    expect(await closed).toBeLessThan(10_000);
    expect(
      (
        await until(
          () => get('bob', '/w/github/team/a/page'),
          (a) => a.status === 404,
        )
      ).status,
    ).toBe(404);
    github.levels.bob = { 1: 'write' };
  }, 30_000);

  it('stops an unused wiki and starts it again on the next request', async () => {
    const before = echo(await get('alice', '/w/github/team/b/page')).pid;
    const gone = await until(
      async () => existsSync(`/proc/${before}`),
      (running) => !running,
    );
    expect(gone).toBe(false);
    const after = echo(await get('alice', '/w/github/team/b/page'));
    expect(after.repo).toBe('team/b');
    expect(after.pid).not.toBe(before);
  }, 30_000);

  it('does not stop a wiki that is not pushed and clean, and pushes before the container stops (R6)', async () => {
    echo(await get('alice', '/w/github/team/a/page'));
    const pid = echo(await get('alice', '/w/github/team/a/page')).pid;
    writeFileSync(join(data, 'wikis', 'github-1', 'unpushed'), 'edit');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(echo(await get('alice', '/w/github/team/a/page')).pid).toBe(pid);
    await stopDoor();
    expect(existsSync(join(data, 'wikis', 'github-1', 'pushed-on-stop'))).toBe(true);
    expect(existsSync(join(data, 'wikis', 'github-1', 'unpushed'))).toBe(false);
    await startDoor();
  }, 30_000);

  it('redirects the old address after a rename and keeps the folder (R10)', async () => {
    const b = github.repos.find((r) => r.id === 2);
    if (b !== undefined) b.name = 'b2';
    await stopDoor();
    await startDoor();
    const moved = await until(
      () => get('alice', '/w/github/team/b/page'),
      (a) => a.status === 301,
    );
    expect(moved.status).toBe(301);
    expect(moved.location).toBe('/w/github/team/b2/page');
    expect(echo(await get('alice', '/w/github/team/b2/page')).repo).toBe('team/b2');
    expect(existsSync(join(data, 'wikis', 'github-2', 'bootstrapped'))).toBe(true);
  }, 30_000);

  it('disconnects a wiki when the app is uninstalled from it, shows admins why and deletes nothing (R11, R15)', async () => {
    const a = github.repos.find((r) => r.id === 1);
    if (a !== undefined) a.installed = false;
    const refused = await until(
      () => get('alice', '/w/github/team/a/page', { accept: 'text/html' }),
      (answer) => answer.status === 403,
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('is disconnected');
    const list = JSON.parse((await get('alice', '/api/front-door/wikis')).body) as {
      wikis: Array<{ name: string; state: string; reason?: string; why?: string }>;
    };
    const shown = list.wikis.find((w) => w.name === 'a');
    expect(shown?.state).toBe('disconnected');
    expect(['token', 'removed', 'gone']).toContain(shown?.reason);
    expect((await get('bob', '/w/github/team/a/page')).status).toBe(404);
    expect(existsSync(join(data, 'wikis', 'github-1', 'pushed-on-stop'))).toBe(true);
    expect(openWikiTable(wikiTableFile(data)).byKey('github-1')).toMatchObject({
      state: 'disconnected',
    });
    if (a !== undefined) a.installed = true;
    await stopDoor();
    await startDoor();
    const back = await until(
      () => get('alice', '/w/github/team/a/page'),
      (answer) => answer.status === 200,
    );
    expect(echo(back).repo).toBe('team/a');
  }, 30_000);

  it('keeps people inside and lets nobody new in while GitHub is down (R14)', async () => {
    echo(await get('alice', '/w/github/team/a/page'));
    github.down = true;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(echo(await get('alice', '/w/github/team/a/page')).repo).toBe('team/a');
    const carol = await signIn('carol');
    expect(carol.status).toBe(502);
    expect(sessions.carol).toBeUndefined();
    github.down = false;
  }, 30_000);

  it('refuses a repository under an owner that is not allowed, and disconnects wikis whose owner is removed from the list (R18)', async () => {
    expect((await signIn('alice', '/auth/github/add-wiki?next=%2F')).status).toBe(302);
    const refused = await send(`${base}/api/front-door/wikis`, {
      method: 'POST',
      headers: { cookie: sessions.alice ?? '', origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 4 }),
    });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'owner-not-allowed' });
    expect((await get('alice', '/w/other/d/page')).status).toBe(404);
    await stopDoor();
    await startDoor({ GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS: 'other' });
    const table = await until(
      async () => openWikiTable(wikiTableFile(data)).list(),
      (wikis) => wikis.every((w) => w.state === 'disconnected'),
    );
    expect(table.map((w) => [w.name, w.state, w.reason])).toEqual([
      ['a', 'disconnected', 'owner-not-allowed'],
      ['b2', 'disconnected', 'owner-not-allowed'],
    ]);
    expect((await get('alice', '/w/github/team/a/page')).status).toBe(403);
    await stopDoor();
    await startDoor();
  }, 30_000);
});
