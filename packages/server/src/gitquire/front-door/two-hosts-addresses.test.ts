import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { stripBrowserHeaders } from './translate.ts';
import { cleanUpRigs, type TwoHostRig, twoHostRig } from './two-hosts.test-helper.ts';

afterEach(cleanUpRigs);

async function both(r: TwoHostRig, who = 'alice'): Promise<string> {
  return r.signIn('forgejo', who, await r.signIn('github', who));
}

function upgradeAnswer(r: TwoHostRig, path: string, cookie: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const s = connect(Number(new URL(r.base).port), '127.0.0.1');
    s.once('error', reject);
    s.once('data', (chunk) => {
      resolve(chunk.toString().split('\r\n')[0] ?? '');
      s.destroy();
    });
    s.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`,
    );
  });
}

interface Echo {
  url: string;
  headers: Record<string, string>;
}

describe('addresses with the host', () => {
  it('keeps the same owner and repository on two hosts apart (S1)', async () => {
    const r = await twoHostRig();
    const cookie = await both(r);
    const gh = (await (await r.get('/w/github/team/a/x', cookie)).json()) as Echo;
    const fj = (await (await r.get('/w/forgejo/team/a/x', cookie)).json()) as Echo;
    expect(gh.headers['x-gitquire-prefix']).toBe('/w/github/team/a');
    expect(fj.headers['x-gitquire-prefix']).toBe('/w/forgejo/team/a');
    const listed = (await (await r.get('/api/front-door/wikis', cookie)).json()) as {
      wikis: { key: string; address: string; fullName: string; hostLabel: string }[];
    };
    expect(listed.wikis.find((wiki) => wiki.key === 'forgejo-1')).toMatchObject({
      address: '/w/forgejo/team/a/',
      fullName: 'forgejo/team/a',
      hostLabel: 'Forgejo',
    });
  });

  it('redirects an old address to the wiki that held it first: page, API and images', async () => {
    const r = await twoHostRig();
    const cookie = await both(r);
    const page = await r.get('/w/team/a/notes/plan?x=1', cookie, { accept: 'text/html' });
    expect([page.status, page.headers.get('location')]).toEqual([
      301,
      '/w/github/team/a/notes/plan?x=1',
    ]);
    const api = await r.get('/w/team/a/api/documents', cookie);
    expect([api.status, api.headers.get('location')]).toEqual([
      301,
      '/w/github/team/a/api/documents',
    ]);
    const image = await r.get('/w/team/f/api/asset?path=a.png', cookie);
    expect([image.status, image.headers.get('location')]).toEqual([
      301,
      '/w/forgejo/team/f/api/asset?path=a.png',
    ]);
    const posted = await fetch(`${r.base}/w/team/a/api/documents`, {
      method: 'POST',
      headers: { cookie, origin: r.base },
      redirect: 'manual',
    });
    expect([posted.status, posted.headers.get('location')]).toEqual([
      308,
      '/w/github/team/a/api/documents',
    ]);
    const root = await r.get('/w/team/a', cookie);
    expect(root.headers.get('location')).toBe('/w/github/team/a/');
  });

  it('answers an old address like an unknown one to a person who cannot open its wiki (S3)', async () => {
    const r = await twoHostRig();
    const carol = await r.signIn('forgejo', 'carol');
    const old = await r.get('/w/team/a/', carol);
    const unknown = await r.get('/w/team/nothing/', carol);
    expect([old.status, await old.text()]).toEqual([unknown.status, await unknown.text()]);
    expect((await r.get('/w/forgejo/team/a/', carol)).status).toBe(200);
  });

  it('reads the address with the host first, so an owner named like a host key is not misread', async () => {
    const r = await twoHostRig();
    r.hosts.github.repos.push({
      host: 'github',
      id: 9,
      owner: 'forgejo',
      ownerId: 99,
      name: 'team',
    });
    r.hosts.github.levels.alice = { ...r.hosts.github.levels.alice, team: 'write' };
    r.table.add({ host: 'github', id: 9, owner: 'forgejo', ownerId: 99, name: 'team' }, 'x', 0);
    const cookie = await both(r);
    const fj = (await (await r.get('/w/forgejo/team/a/x', cookie)).json()) as Echo;
    expect(fj.headers['x-gitquire-prefix']).toBe('/w/forgejo/team/a');
    const old = await r.get('/w/forgejo/team/', cookie);
    expect(old.headers.get('location')).toBe('/w/github/forgejo/team/');
  });

  it('refuses an upgrade at an old address, the browser comes back at the new one', async () => {
    const r = await twoHostRig();
    const cookie = await both(r);
    const socket = await new Promise<string>((resolve, reject) => {
      const s = connect(Number(new URL(r.base).port), '127.0.0.1');
      s.once('error', reject);
      s.once('data', (chunk) => {
        resolve(chunk.toString().split('\r\n')[0] ?? '');
        s.destroy();
      });
      s.write(
        `GET /w/team/a/collab HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`,
      );
    });
    expect(socket).toBe('HTTP/1.1 404 Not Found');
  });

  it('tells a signed-out caller nothing about which wikis exist, also for /mcp and live editing (S3)', async () => {
    const r = await twoHostRig({ agents: true });
    const answers = await Promise.all(
      ['/w/forgejo/team/f/mcp', '/w/forgejo/team/nothing/mcp'].map(async (path) => {
        const answer = await r.get(path, '');
        return { status: answer.status, body: await answer.text() };
      }),
    );
    expect(answers[0]?.status).toBe(404);
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]?.body).toContain('/mcp/forgejo');
    const old = await Promise.all(
      ['/w/team/f/mcp', '/w/team/nothing/mcp'].map(async (path) => (await r.get(path, '')).text()),
    );
    expect(old[0]).toBe(old[1]);
    for (const path of [
      '/w/github/team/a/collab',
      '/w/github/team/zzz/collab',
      '/w/team/a/collab',
    ]) {
      expect(await upgradeAnswer(r, path, '')).toBe('HTTP/1.1 401 Unauthorized');
    }
  });

  it('never hands the front door’s sign-in state cookies to an editor process', () => {
    const req = {
      headers: { cookie: 'gq_oauth_state=a; gq_oauth_state_forgejo=b; gq_session=c; keep=d' },
    } as unknown as Parameters<typeof stripBrowserHeaders>[0];
    stripBrowserHeaders(req);
    expect(req.headers.cookie).toBe('keep=d');
  });
});

describe('Add a wiki with two hosts', () => {
  it('asks for the host when two are signed in, and goes straight on with one', async () => {
    const r = await twoHostRig();
    const cookie = await both(r);
    const choice = await (await r.get('/add-wiki', cookie)).text();
    expect(choice).toContain('href="/add-wiki?host=github"');
    expect(choice).toContain('href="/add-wiki?host=forgejo"');
    const carol = await r.signIn('forgejo', 'carol');
    const hers = await r.get('/add-wiki', carol);
    expect(hers.status).toBe(302);
    expect(hers.headers.get('location')).toBe(
      '/auth/forgejo/add-wiki?next=%2Fadd-wiki%3Fhost%3Dforgejo',
    );
    const github = await r.get('/add-wiki?host=github', cookie);
    expect(github.headers.get('location')).toBe(
      '/auth/github/add-wiki?next=%2Fadd-wiki%3Fhost%3Dgithub',
    );
    const refused = await fetch(`${r.base}/api/front-door/wikis`, {
      method: 'POST',
      headers: { cookie, origin: r.base, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1 }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'host-required' });
  });
});
