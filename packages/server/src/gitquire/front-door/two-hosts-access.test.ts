import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_TTL_MS } from './access.ts';
import { cleanUpRigs, type TwoHostRig, twoHostRig } from './two-hosts.test-helper.ts';

afterEach(cleanUpRigs);

interface Echo {
  repo: string;
  host: string;
  url: string;
  headers: Record<string, string>;
}

function principal(echo: Echo): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(echo.headers['x-gitquire-principal'] ?? '', 'base64url').toString(),
  ) as Record<string, unknown>;
}

async function both(r: TwoHostRig, who = 'alice'): Promise<string> {
  return r.signIn('forgejo', who, await r.signIn('github', who));
}

function upgrade(r: TwoHostRig, path: string, cookie: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(r.base).port), '127.0.0.1');
    socket.once('error', reject);
    socket.once('data', (chunk) => {
      resolve(chunk.toString('utf8').split('\r\n')[0] ?? '');
      socket.destroy();
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`,
    );
  });
}

describe('two hosts in one front door', () => {
  it('lists the wikis of every signed-in account, each checked on its own host', async () => {
    const r = await twoHostRig();
    const cookie = await both(r);
    const body = (await (await r.get('/api/front-door/wikis', cookie)).json()) as {
      wikis: { key: string; admin: boolean }[];
      accounts: unknown[];
      signInWith: unknown[];
    };
    expect(body.wikis.map((wiki) => `${wiki.key}:${wiki.admin}`).sort()).toEqual([
      'forgejo-1:false',
      'forgejo-3:true',
      'github-1:true',
      'github-2:false',
    ]);
    expect(body.signInWith).toEqual([]);
    expect(body.accounts).toHaveLength(2);
    expect(r.hosts.github.asked.filter((line) => line.includes(':3'))).toEqual([]);
    const onlyGithub = await r.signIn('github', 'alice');
    const one = (await (await r.get('/api/front-door/wikis', onlyGithub)).json()) as {
      wikis: { key: string }[];
      signInWith: unknown[];
    };
    expect(one.wikis.map((wiki) => wiki.key).sort()).toEqual(['github-1', 'github-2']);
    expect(one.signInWith).toEqual([
      { host: 'forgejo', label: 'Forgejo', address: '/auth/forgejo/login' },
    ]);
  });

  it('forwards the account of the wiki’s host, so the same login on two hosts is two people (S1)', async () => {
    const r = await twoHostRig();
    const cookie = await both(r);
    const toForgejo = (await (await r.get('/w/forgejo/team/f/page', cookie)).json()) as Echo;
    expect(toForgejo.host).toBe('forgejo');
    expect(principal(toForgejo)).toMatchObject({ id: 11, login: 'alice', repoAdmin: true });
    const toGithub = (await (await r.get('/w/github/team/g/page', cookie)).json()) as Echo;
    expect(toGithub.host ?? 'github').toBe('github');
    expect(principal(toGithub).repoAdmin).toBeUndefined();
    expect(r.hosts.forgejo.asked.some((line) => line.startsWith('bot:alice:2'))).toBe(false);
  });

  it('answers a wiki of a host the person is not signed in on exactly like an unknown address (S3)', async () => {
    const r = await twoHostRig();
    const github = await r.signIn('github', 'alice');
    for (const accept of ['text/html', 'application/json']) {
      const forgejo = await r.get('/w/forgejo/team/f/', github, { accept });
      const unknown = await r.get('/w/github/team/nothing-here/', github, { accept });
      expect([forgejo.status, await forgejo.text()]).toEqual([
        unknown.status,
        await unknown.text(),
      ]);
      expect(forgejo.status).toBe(404);
    }
    const api = await r.get('/w/forgejo/team/f/api/documents', github);
    expect(api.status).toBe(404);
    expect(await upgrade(r, '/w/forgejo/team/f/collab', github)).toBe('HTTP/1.1 404 Not Found');
    expect(await upgrade(r, '/w/github/team/g/collab', github)).toBe(
      'HTTP/1.1 101 Switching Protocols',
    );
    expect(r.hosts.forgejo.asked).toEqual([]);
  });

  it('keeps the server-administrator flag on the host that grants it (S2)', async () => {
    const r = await twoHostRig();
    r.table.disconnect('forgejo-3', 'token');
    r.table.disconnect('github-2', 'token');
    const alice = await both(r);
    const carol = await r.signIn('forgejo', 'carol');
    const home = (cookie: string) =>
      r.get('/', cookie, { accept: 'text/html' }).then((answer) => answer.text());
    const hers = await home(carol);
    expect(hers).toContain('data-wiki="forgejo-3"');
    expect(hers).toContain('name="key" value="forgejo-3"');
    expect(hers).not.toContain('github-2');
    const his = await home(alice);
    expect(his).toContain('name="key" value="github-2"');
    expect(his).not.toMatch(/name="key" value="forgejo-3"/);
    const removeAsAlice = await fetch(`${r.base}/add-wiki/remove`, {
      method: 'POST',
      headers: {
        cookie: alice,
        origin: r.base,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'key=forgejo-3&confirm=yes',
    });
    expect(removeAsAlice.status).toBe(404);
    expect(r.table.byKey('forgejo-3')).toBeDefined();
  });

  it('cuts off only the host where access was removed', async () => {
    const r = await twoHostRig();
    const cookie = await both(r);
    expect((await r.get('/w/forgejo/team/f/x', cookie)).status).toBe(200);
    r.hosts.forgejo.levels.alice = {};
    r.advance(ACCESS_TTL_MS + 1);
    expect((await r.get('/w/forgejo/team/f/x', cookie)).status).toBe(404);
    expect((await r.get('/w/github/team/g/x', cookie)).status).toBe(200);
  });

  it('keeps the other host working while one is down (S7)', async () => {
    const r = await twoHostRig();
    const cookie = await r.signIn('forgejo', 'carol', await r.signIn('github', 'bob'));
    r.hosts.forgejo.bot.down = true;
    expect([404, 502]).toContain((await r.get('/w/forgejo/team/f/x', cookie)).status);
    expect((await r.get('/w/github/team/a/x', cookie)).status).toBe(200);
    const fresh = await r.signIn('github', 'alice');
    expect((await r.get('/w/github/team/g/x', fresh)).status).toBe(200);
  });
});
