import { afterEach, describe, expect, it } from 'vitest';
import { decodeSigned, encodeSigned } from '../signed-cookie.ts';
import {
  hostFingerprint,
  MAX_SESSION_COOKIE_BYTES,
  readDoorSession,
  writeDoorSession,
} from './door-session.ts';
import { cleanUpRigs, cookiesOf, twoHostRig } from './two-hosts.test-helper.ts';

afterEach(cleanUpRigs);

const SECRET = '0123456789abcdef0123456789abcdef';
const fingerprints = new Map([
  ['github', hostFingerprint({ kind: 'github', webUrl: 'https://github.example' })],
  ['forgejo', hostFingerprint({ kind: 'forgejo', webUrl: 'https://forgejo.example' })],
  ['lab', hostFingerprint({ kind: 'forgejo', webUrl: 'https://lab.example' })],
]);
const hostsFor = (primaryKey = 'github') => ({ primaryKey, fingerprints });
const person = (id: number, login: string) => ({ id, login, name: login, avatarUrl: '' });

function payloadOf(cookie: string): Record<string, unknown> {
  return decodeSigned(SECRET, decodeURIComponent(cookie.slice('gq_session='.length))) as Record<
    string,
    unknown
  >;
}

function read(raw: string, nowSeconds = 0, primaryKey = 'github') {
  return readDoorSession(SECRET, raw, { ...hostsFor(primaryKey), nowSeconds });
}

describe('the session cookie', () => {
  it('writes the one-host form while only the first host is signed in, and reads it back', () => {
    const one = new Map([['github', { person: person(11, 'alice'), exp: 2000 }]]);
    const raw = writeDoorSession(SECRET, one, hostsFor());
    expect(decodeSigned(SECRET, raw)).toEqual({
      v: 1,
      id: 11,
      login: 'alice',
      name: 'alice',
      avatarUrl: '',
      exp: 2000,
      h: fingerprints.get('github'),
    });
    expect(read(raw, 1000).get('github')).toEqual({ person: person(11, 'alice'), exp: 2000 });
    const before = encodeSigned(SECRET, { v: 1, ...person(11, 'alice'), exp: 2000 });
    expect(read(before, 1000).get('github')?.person.login).toBe('alice');
  });

  it('holds one account per host, drops expired and unconfigured ones (S6)', () => {
    const both = new Map([
      ['github', { person: person(11, 'alice'), exp: 2000 }],
      ['forgejo', { person: person(11, 'alice'), exp: 1500 }],
      ['gone', { person: person(11, 'alice'), exp: 3000 }],
    ]);
    const raw = writeDoorSession(SECRET, both, hostsFor());
    expect([...read(raw, 1000).keys()]).toEqual(['github', 'forgejo']);
    expect([...read(raw, 1600).keys()]).toEqual(['github']);
    expect(read(raw, 2100).size).toBe(0);
    expect(read(encodeSigned('another secret that is long enough!', {})).size).toBe(0);
  });

  it.each([
    ['long ASCII', 'N'.repeat(500), 2],
    ['CJK', '名'.repeat(400), 3],
    ['control characters', '\u0001'.repeat(400), 3],
  ])('stays under the cookie limit with %s names (S6)', (_what, name, count) => {
    const big = {
      id: 99_999_999,
      login: 'x'.repeat(39),
      name,
      avatarUrl: `https://a.example/${'p'.repeat(400)}`,
    };
    const keys = ['github', 'forgejo', 'lab'].slice(0, count);
    const accounts = new Map(keys.map((key) => [key, { person: big, exp: 2000 }]));
    const raw = writeDoorSession(SECRET, accounts, hostsFor());
    expect(encodeURIComponent(raw).length).toBeLessThanOrEqual(MAX_SESSION_COOKIE_BYTES);
    expect([...read(raw, 1000).keys()]).toEqual(keys);
    expect(read(raw, 1000).get('github')?.person.login).toBe('x'.repeat(39));
  });

  it('drops an account whose key now names another server, so ids never cross hosts (S1)', () => {
    const one = new Map([['github', { person: person(11, 'alice'), exp: 2000 }]]);
    const v1 = writeDoorSession(SECRET, one, hostsFor());
    expect(read(v1, 0, 'forgejo').size).toBe(0);
    const two = new Map([
      ['github', { person: person(11, 'alice'), exp: 2000 }],
      ['forgejo', { person: person(12, 'bob'), exp: 2000 }],
    ]);
    const v2 = writeDoorSession(SECRET, two, hostsFor());
    const moved = new Map(fingerprints);
    moved.set('forgejo', hostFingerprint({ kind: 'forgejo', webUrl: 'https://elsewhere.example' }));
    const after = readDoorSession(SECRET, v2, {
      primaryKey: 'github',
      fingerprints: moved,
      nowSeconds: 0,
    });
    expect([...after.keys()]).toEqual(['github']);
  });

  it('writes no account under another host key than it was given', () => {
    const raw = writeDoorSession(
      SECRET,
      new Map([['forgejo', { person: person(11, 'alice'), exp: 2000 }]]),
      hostsFor(),
    );
    expect(read(raw).has('github')).toBe(false);
    expect(read(raw).get('forgejo')?.person.login).toBe('alice');
  });
});

describe('signing in with two hosts', () => {
  it('sends a person who is not signed in to the host choice, which offers every host', async () => {
    const r = await twoHostRig();
    const home = await r.get('/', '', { accept: 'text/html' });
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/auth/sign-in?next=%2F');
    const page = await (await r.get('/auth/sign-in?next=%2F', '')).text();
    expect(page).toContain('href="/auth/github/login?next=%2F"');
    expect(page).toContain('href="/auth/forgejo/login?next=%2F"');
    const api = await r.get('/api/front-door/wikis', '');
    expect(await api.json()).toEqual({ error: 'not-signed-in', signIn: '/auth/sign-in' });
  });

  it('keeps both accounts in one session, as two people with the same login (S1)', async () => {
    const r = await twoHostRig();
    const github = await r.signIn('github', 'alice');
    expect(payloadOf(github).v).toBe(1);
    const both = await r.signIn('forgejo', 'alice', github);
    expect(payloadOf(both).v).toBe(2);
    const me = (await (await r.get('/auth/me', both)).json()) as Record<string, unknown>;
    expect(me.accounts).toEqual([
      { host: 'github', label: 'GitHub', login: 'alice', principalId: 'github-11' },
      { host: 'forgejo', label: 'Forgejo', login: 'alice', principalId: 'forgejo-11' },
    ]);
    expect(me.principalId).toBe('github-11');
    const page = await (await r.get('/auth/sign-in?next=%2F', both)).text();
    expect(page).toContain('GitHub: signed in as <strong>@alice</strong>');
    expect(page).toContain('Forgejo: signed in as <strong>@alice</strong>');
  });

  it('sends each host only its own client secret and callback address (S4)', async () => {
    const r = await twoHostRig();
    const start = await r.get('/auth/forgejo/login?next=%2F', '');
    const to = new URL(start.headers.get('location') ?? '');
    expect(to.host).toBe('forgejo.example');
    expect(to.searchParams.get('redirect_uri')).toBe(`${r.base}/auth/forgejo/callback`);
    await r.signIn('forgejo', 'carol');
    expect(r.hosts.forgejo.asked).toContain('exchange:forgejo-id:forgejo-secret');
    expect(r.hosts.github.asked.filter((line) => line.startsWith('exchange'))).toEqual([]);
  });

  it('refuses a callback at another host than the one the sign-in started at (S5)', async () => {
    const r = await twoHostRig();
    const start = await r.get('/auth/github/login?next=%2F', '');
    const state = cookiesOf(start).find((c) => c.startsWith('gq_oauth_state=')) ?? '';
    const back = await r.get('/auth/forgejo/callback?code=alice&state=state-1', state);
    expect(back.status).toBe(400);
    expect(cookiesOf(back).some((c) => c.startsWith('gq_session=') && c !== 'gq_session=')).toBe(
      false,
    );
    expect(r.hosts.forgejo.asked).toEqual([]);
  });

  it('refuses a state cookie of the first host, old or new, at a further host’s callback (S5)', async () => {
    const r = await twoHostRig();
    const old = encodeURIComponent(
      encodeSigned(SECRET, { state: 'state-1', next: '/', purpose: 'sign-in', exp: 9e9 }),
    );
    for (const name of ['gq_oauth_state', 'gq_oauth_state_forgejo']) {
      const back = await r.get(
        '/auth/forgejo/callback?code=alice&state=state-1',
        name === 'gq_oauth_state' ? `${name}=${old}` : `${name}=${old}`,
      );
      expect(back.status).toBe(400);
    }
    expect(r.hosts.forgejo.asked).toEqual([]);
  });

  it('refuses a sign-out from another site', async () => {
    const r = await twoHostRig();
    const cookie = await r.signIn('github', 'alice');
    const answer = await fetch(`${r.base}/auth/logout`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'host=github',
    });
    expect(answer.status).toBe(403);
  });

  it('lets one account expire without ending the other (S6)', async () => {
    const r = await twoHostRig({ sessionSeconds: 100 });
    const github = await r.signIn('github', 'alice');
    r.advance(60_000);
    const both = await r.signIn('forgejo', 'alice', github);
    r.advance(50_000);
    const me = (await (await r.get('/auth/me', both)).json()) as Record<string, unknown>;
    expect(me.accounts).toEqual([
      { host: 'forgejo', label: 'Forgejo', login: 'alice', principalId: 'forgejo-11' },
    ]);
    expect(me.login).toBeUndefined();
  });

  it('signs out of one host or of all', async () => {
    const r = await twoHostRig();
    const both = await r.signIn('forgejo', 'alice', await r.signIn('github', 'alice'));
    const page = await (await r.get('/auth/logout', both)).text();
    expect(page).toContain('name="host" value="forgejo"');
    expect(page).toContain('Sign out of all');
    const post = (cookie: string, body: string) =>
      fetch(`${r.base}/auth/logout`, {
        method: 'POST',
        headers: {
          cookie,
          origin: r.base,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    const one = await post(both, 'host=forgejo');
    expect(await one.text()).toContain('Still signed in with GitHub');
    const left = one.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    expect(payloadOf(left)).toMatchObject({ v: 1, login: 'alice' });
    const all = await post(both, '');
    expect(all.headers.getSetCookie()[0]).toMatch(/^gq_session=;/);
  });
});

describe('one host (S8)', () => {
  it('starts the sign-in at the host right away and signs out without asking which host', async () => {
    const r = await twoHostRig({ only: 'github' });
    const home = await r.get('/', '', { accept: 'text/html' });
    expect(home.headers.get('location')).toBe('/auth/github/login?next=%2F');
    expect((await r.get('/auth/sign-in', '')).status).toBe(404);
    const start = await r.get('/auth/github/login?next=%2F', '');
    const state = cookiesOf(start).find((c) => c.startsWith('gq_oauth_state=')) ?? '';
    const back = await r.get('/auth/github/callback?code=alice&state=state-1', state);
    expect(back.headers.getSetCookie().find((line) => line.startsWith('gq_session='))).toContain(
      'Max-Age=3600',
    );
    const session = await r.signIn('github', 'alice');
    expect(payloadOf(session).v).toBe(1);
    const me = (await (await r.get('/auth/me', session)).json()) as Record<string, unknown>;
    expect(me.accounts).toBeUndefined();
    expect(await (await r.get('/auth/logout', session)).text()).not.toContain('name="host"');
  });
});
