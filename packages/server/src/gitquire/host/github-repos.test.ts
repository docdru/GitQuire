import { describe, expect, it } from 'vitest';
import { createGitHubDoorHost, RENEW_BEFORE_EXPIRY_MS } from './github.ts';

const API = 'https://api.github.com';
const NOW = Date.parse('2026-11-21T12:00:00Z');

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = (method: string, path: string, token: string, body: unknown) => Reply;

function fetchFrom(route: Route, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(API, '');
    const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push(`${method} ${path} ${token}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
    const reply = route(method, path, token, body);
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  }) as typeof fetch;
}

function repoRecord(id: number, owner: string, ownerId: number, name: string, admin: boolean) {
  return {
    id,
    node_id: `R_${id}`,
    name,
    full_name: `${owner}/${name}`,
    private: true,
    owner: { login: owner, id: ownerId, type: 'Organization' },
    permissions: { admin, maintain: false, push: true, triage: true, pull: true },
  };
}

const installationsBody = {
  total_count: 2,
  installations: [
    { id: 11, app_id: 5, account: { login: 'acme', id: 100, type: 'Organization' } },
    { id: 12, app_id: 5, account: { login: 'dora', id: 7, type: 'User' } },
  ],
};

function tokenBody(token: string, expiresAt: string) {
  return {
    token,
    expires_at: expiresAt,
    permissions: { contents: 'write', metadata: 'read' },
    repository_selection: 'selected',
  };
}

const notInInstallation = {
  message:
    'There is at least one repository that does not exist or is not accessible to the parent installation.',
  documentation_url:
    'https://docs.github.com/rest/apps/apps#create-an-installation-access-token-for-an-app',
  status: '422',
};

function door(
  route: Route,
  calls: string[] = [],
  options: { now?: () => number; app?: boolean } = {},
) {
  return createGitHubDoorHost(
    { webUrl: 'https://github.com', apiUrl: API, repo: undefined },
    {
      fetch: fetchFrom(route, calls),
      now: options.now ?? (() => NOW),
      ...(options.app === false
        ? { installationToken: () => 'single' }
        : { app: { jwt: () => 'jwt' } }),
    },
  );
}

describe('GitHub door host for several repositories', () => {
  it('lists the repos of the installations the person sees, where the person is admin', async () => {
    const calls: string[] = [];
    const host = door((_method, path) => {
      if (path === '/user/installations?per_page=100&page=1') {
        return { status: 200, body: installationsBody };
      }
      if (path === '/user/installations/11/repositories?per_page=100&page=1') {
        return {
          status: 200,
          body: {
            total_count: 3,
            repository_selection: 'selected',
            repositories: [
              repoRecord(201, 'acme', 100, 'notes', true),
              repoRecord(202, 'acme', 100, 'handbook', false),
              { ...repoRecord(203, 'acme', 100, 'ops', false), permissions: { maintain: true } },
            ],
          },
        };
      }
      if (path === '/user/installations/12/repositories?per_page=100&page=1') {
        return { status: 404, body: { message: 'Not Found' } };
      }
      return { status: 404 };
    }, calls);
    expect(await host.addableRepos('person')).toEqual({
      state: 'listed',
      repos: [
        { host: 'github', id: 201, owner: 'acme', ownerId: 100, name: 'notes' },
        { host: 'github', id: 203, owner: 'acme', ownerId: 100, name: 'ops' },
      ],
    });
    expect(calls.every((call) => call.split(' ')[2] === 'person')).toBe(true);
  });

  it('pages through installations and repositories', async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      repoRecord(1000 + i, 'acme', 100, `r${i}`, i === 0),
    );
    const host = door((_method, path) => {
      if (path === '/user/installations?per_page=100&page=1') {
        return {
          status: 200,
          body: { total_count: 1, installations: [installationsBody.installations[0]] },
        };
      }
      if (path === '/user/installations/11/repositories?per_page=100&page=1') {
        return { status: 200, body: { total_count: 101, repositories: many } };
      }
      if (path === '/user/installations/11/repositories?per_page=100&page=2') {
        return {
          status: 200,
          body: { total_count: 101, repositories: [repoRecord(2000, 'acme', 100, 'last', true)] },
        };
      }
      return { status: 404 };
    });
    const answer = await host.addableRepos('person');
    expect(answer.state === 'listed' && answer.repos.map((r) => r.id)).toEqual([1000, 2000]);
  });

  it('tells a refused sign-in token from an unreachable host', async () => {
    expect(
      await door(() => ({ status: 401, body: { message: 'Bad credentials' } })).addableRepos('p'),
    ).toEqual({
      state: 'refused',
      whose: 'person',
    });
    expect(await door(() => ({ status: 502 })).addableRepos('p')).toEqual({ state: 'unreachable' });
    expect(
      await door(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' } })).addableRepos(
        'p',
      ),
    ).toEqual({ state: 'unreachable' });
  });

  it('mints a token limited to the one repo through its installation, and caches it', async () => {
    const calls: string[] = [];
    let now = NOW;
    let minted = 0;
    const host = door(
      (method, path) => {
        if (path === '/repos/acme/notes/installation') {
          return { status: 200, body: { id: 11, app_id: 5, account: { login: 'acme', id: 100 } } };
        }
        if (method === 'POST' && path === '/app/installations/11/access_tokens') {
          minted += 1;
          return {
            status: 201,
            body: tokenBody(`ghs_${minted}`, new Date(now + 60 * 60 * 1000).toISOString()),
          };
        }
        return { status: 404 };
      },
      calls,
      { now: () => now },
    );
    expect(await host.tokenFor({ owner: 'acme', name: 'notes' })).toBe('ghs_1');
    expect(await host.tokenFor({ owner: 'ACME', name: 'Notes' })).toBe('ghs_1');
    expect(calls).toEqual([
      'GET /repos/acme/notes/installation jwt',
      'POST /app/installations/11/access_tokens jwt {"repositories":["notes"]}',
    ]);
    now += 60 * 60 * 1000 - RENEW_BEFORE_EXPIRY_MS + 1;
    expect(await host.tokenFor({ owner: 'acme', name: 'notes' })).toBe('ghs_2');
    const [first, second] = await Promise.all([
      host.tokenFor({ owner: 'acme', name: 'notes' }),
      host.tokenFor({ owner: 'acme', name: 'notes' }),
    ]);
    expect([first, second]).toEqual(['ghs_2', 'ghs_2']);
    expect(minted).toBe(2);
  });

  it('never hands out the app key: a refused or missing installation gives no token', async () => {
    const uninstalled = door(() => ({ status: 404, body: { message: 'Not Found' } }));
    expect(await uninstalled.tokenFor({ owner: 'acme', name: 'notes' })).toBeUndefined();
    expect(await uninstalled.health({ owner: 'acme', name: 'notes' })).toBe('refused:removed');
    expect(await uninstalled.accessByBot('bob', { owner: 'acme', name: 'notes' })).toBe(
      'refused:removed',
    );

    const keyRefused = door(() => ({
      status: 401,
      body: { message: 'A JSON web token could not be decoded' },
    }));
    expect(await keyRefused.tokenFor({ owner: 'acme', name: 'notes' })).toBeUndefined();
    expect(await keyRefused.health({ owner: 'acme', name: 'notes' })).toBe('refused:token');

    const mintRefused = door((method, path) =>
      method === 'POST'
        ? { status: 403, body: { message: 'Resource not accessible by integration' } }
        : path.endsWith('/installation')
          ? { status: 200, body: { id: 11 } }
          : { status: 404 },
    );
    expect(await mintRefused.health({ owner: 'acme', name: 'notes' })).toBe('refused:token');

    const badKey = createGitHubDoorHost(
      { webUrl: 'https://github.com', apiUrl: API, repo: undefined },
      {
        fetch: fetchFrom(() => ({ status: 200, body: {} })),
        app: {
          jwt: () => {
            throw new Error('not a key');
          },
        },
      },
    );
    expect(await badKey.health({ owner: 'acme', name: 'notes' })).toBe('refused:token');
    expect(await door(() => ({ status: 503 })).health({ owner: 'acme', name: 'notes' })).toBe(
      'unreachable',
    );
  });

  it('keeps a still valid token when renewing finds the host unreachable', async () => {
    let now = NOW;
    let down = false;
    const host = door(
      (method, path) => {
        if (down) return { status: 502 };
        if (path === '/repos/acme/notes/installation') return { status: 200, body: { id: 11 } };
        if (method === 'POST') {
          return {
            status: 201,
            body: tokenBody('ghs_1', new Date(NOW + 60 * 60 * 1000).toISOString()),
          };
        }
        return { status: 404 };
      },
      [],
      { now: () => now },
    );
    expect(await host.tokenFor({ owner: 'acme', name: 'notes' })).toBe('ghs_1');
    down = true;
    now += 55 * 60 * 1000;
    expect(await host.tokenFor({ owner: 'acme', name: 'notes' })).toBe('ghs_1');
    now += 10 * 60 * 1000;
    expect(await host.tokenFor({ owner: 'acme', name: 'notes' })).toBeUndefined();
    expect(await host.health({ owner: 'acme', name: 'notes' })).toBe('unreachable');
  });

  it('re-checks people with the token of their own repo', async () => {
    const calls: string[] = [];
    const host = door((method, path) => {
      if (path.endsWith('/installation')) return { status: 200, body: { id: 11 } };
      if (method === 'POST')
        return { status: 201, body: tokenBody('ghs_notes', '2026-11-21T13:00:00Z') };
      if (path === '/repos/acme/notes/collaborators/bob/permission') {
        return { status: 200, body: { permission: 'write', role_name: 'write' } };
      }
      return { status: 404 };
    }, calls);
    expect(await host.accessByBot('bob', { owner: 'acme', name: 'notes' })).toBe('write');
    expect(calls.at(-1)).toBe('GET /repos/acme/notes/collaborators/bob/permission ghs_notes');
  });

  it('finds a repo by its number through the installation that holds it', async () => {
    const calls: string[] = [];
    const host = door((method, path, _token, body) => {
      if (path === '/app/installations?per_page=100&page=1') {
        return { status: 200, body: [{ id: 11 }, { id: 12 }] };
      }
      if (method === 'POST' && path === '/app/installations/11/access_tokens') {
        return { status: 422, body: notInInstallation };
      }
      if (method === 'POST' && path === '/app/installations/12/access_tokens') {
        expect(body).toEqual({ repository_ids: [301], permissions: { metadata: 'read' } });
        return { status: 201, body: tokenBody('ghs_meta', '2026-11-21T13:00:00Z') };
      }
      if (path === '/repositories/301') {
        return { status: 200, body: repoRecord(301, 'dora-renamed', 7, 'diary', true) };
      }
      return { status: 404 };
    }, calls);
    expect(await host.repoById(301)).toEqual({
      state: 'found',
      repo: { host: 'github', id: 301, owner: 'dora-renamed', ownerId: 7, name: 'diary' },
    });
    expect(calls.at(-1)).toBe('GET /repositories/301 ghs_meta');
    calls.length = 0;
    await host.repoById(301);
    expect(calls[0]).toBe(
      'POST /app/installations/12/access_tokens jwt {"repository_ids":[301],"permissions":{"metadata":"read"}}',
    );
  });

  it('answers gone, refused or unreachable for a repo number', async () => {
    const none = door((method, path) => {
      if (path.startsWith('/app/installations?')) return { status: 200, body: [{ id: 11 }] };
      if (method === 'POST') return { status: 422, body: notInInstallation };
      return { status: 404 };
    });
    expect(await none.repoById(9)).toEqual({ state: 'gone' });
    expect(await door(() => ({ status: 401 })).repoById(9)).toEqual({
      state: 'refused',
      refusal: 'token',
    });
    expect(await door(() => ({ status: 500 })).repoById(9)).toEqual({ state: 'unreachable' });
  });

  it('keeps the one-repo behaviour when no app key is given', async () => {
    const calls: string[] = [];
    const single = door(
      (_method, path) => {
        if (path === '/repositories/201')
          return { status: 200, body: repoRecord(201, 'acme', 100, 'notes', true) };
        if (path === '/repos/acme/notes')
          return { status: 200, body: repoRecord(201, 'acme', 100, 'notes', true) };
        return { status: 404 };
      },
      calls,
      { app: false },
    );
    expect(await single.tokenFor({ owner: 'acme', name: 'notes' })).toBeUndefined();
    expect(await single.repoById(201)).toMatchObject({
      state: 'found',
      repo: { id: 201, ownerId: 100 },
    });
    expect(await single.repoById(5)).toEqual({ state: 'gone' });
    expect(await single.health({ owner: 'acme', name: 'notes' })).toBe('ok');
    expect(await single.health({ owner: 'acme', name: 'gone' })).toBe('refused:removed');
    expect(calls.every((call) => call.split(' ')[2] === 'single')).toBe(true);
  });
});
