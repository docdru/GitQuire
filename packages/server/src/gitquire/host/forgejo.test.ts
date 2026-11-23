import { describe, expect, it } from 'vitest';
import { createForgejoDoorHost, forgejoMajorVersion } from './forgejo.ts';

const repo = { owner: 'team', name: 'wiki' };
const API = 'https://git.example.org/api/v1';

type Route = (path: string, token: string | undefined) => { status: number; body?: unknown };

function fetchFrom(route: Route, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization') ?? undefined;
    const token = auth?.replace(/^token /, '');
    calls.push(`${init?.method ?? 'GET'} ${url.replace(API, '')} ${token ?? '-'}`);
    if (url.startsWith('https://git.example.org/login/')) {
      return new Response(JSON.stringify({ access_token: 'person' }), { status: 200 });
    }
    const answer = route(url.replace(API, ''), token);
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status,
    });
  }) as typeof fetch;
}

function door(route: Route, calls: string[] = []) {
  return createForgejoDoorHost(
    { webUrl: 'https://git.example.org', apiUrl: API, repo },
    { fetch: fetchFrom(route, calls), botToken: () => 'bot', repoToken: () => 'limited' },
  );
}

describe('Forgejo door host', () => {
  it('signs in with the code flow and the read-only scopes found in stage 0', async () => {
    const calls: string[] = [];
    const host = door(() => ({ status: 404 }), calls);
    const url = new URL(
      host.authorizeUrl({ clientId: 'cid', redirectUri: 'https://wiki/cb', state: 's' }),
    );
    expect(url.origin + url.pathname).toBe('https://git.example.org/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'https://wiki/cb',
      response_type: 'code',
      scope: 'read:user read:repository',
      state: 's',
    });
    let sent: unknown;
    const exchange = createForgejoDoorHost(
      { webUrl: 'https://git.example.org', apiUrl: API, repo },
      {
        fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
          sent = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
        }) as typeof fetch,
      },
    );
    expect(
      await exchange.exchangeCode({
        clientId: 'cid',
        clientSecret: 'sec',
        code: 'c',
        redirectUri: 'https://wiki/cb',
      }),
    ).toBe('tok');
    expect(sent).toEqual({
      client_id: 'cid',
      client_secret: 'sec',
      code: 'c',
      grant_type: 'authorization_code',
      redirect_uri: 'https://wiki/cb',
    });
  });

  it('reads the person and their access with the sign-in token', async () => {
    const host = door((path) => {
      if (path === '/user') {
        return {
          status: 200,
          body: { id: 2, login: 'bob', full_name: '', avatar_url: 'https://a/2' },
        };
      }
      if (path === '/repos/team/wiki')
        return { status: 200, body: { permissions: { push: true } } };
      return { status: 404 };
    });
    expect(await host.person('t')).toEqual({
      id: 2,
      login: 'bob',
      name: 'bob',
      avatarUrl: 'https://a/2',
    });
    expect(await host.access('t', repo)).toBe('write');
    expect(await host.access('t', { owner: 'team', name: 'other' })).toBe('none');
  });

  it('maps the re-check statuses of stage 0 (F4, F9) onto R15', async () => {
    const calls: string[] = [];
    const permission = (status: number, body?: unknown, repoStatus = 200) =>
      door((path) => {
        if (path.endsWith('/permission')) return { status, body };
        if (path === '/repos/team/wiki') return { status: repoStatus, body: {} };
        return { status: 404 };
      }, calls);
    expect(await permission(200, { permission: 'admin' }).accessByBot('bob', repo)).toBe('admin');
    expect(await permission(200, { permission: 'owner' }).accessByBot('bob', repo)).toBe('admin');
    expect(await permission(200, { permission: 'write' }).accessByBot('bob', repo)).toBe('write');
    expect(await permission(200, { permission: 'read' }).accessByBot('bob', repo)).toBe('none');
    expect(await permission(404).accessByBot('nobody', repo)).toBe('none');
    expect(await permission(404, undefined, 404).accessByBot('bob', repo)).toBe('refused:removed');
    expect(await permission(403).accessByBot('bob', repo)).toBe('refused:not-admin');
    expect(await permission(401).accessByBot('bob', repo)).toBe('refused:token');
    expect(await permission(502).accessByBot('bob', repo)).toBe('unreachable');
    expect(calls.every((call) => call.endsWith(' bot'))).toBe(true);
  });

  it('goes by repository id where it has one, so a new repository under an old name is not asked', async () => {
    const calls: string[] = [];
    const renamed = { owner: 'team', name: 'old', id: 7 };
    const host = createForgejoDoorHost(
      { webUrl: 'https://git.example.org', apiUrl: API, repo: undefined },
      {
        botToken: () => 'bot',
        repoTokens: { tokenFor: (asked) => (asked.id === 7 ? 'limited' : undefined) },
        fetch: fetchFrom((path, token) => {
          if (path === '/repositories/7') {
            return {
              status: 200,
              body: {
                id: 7,
                name: 'new',
                owner: { id: 1, login: 'team' },
                permissions: token === 'person' ? { admin: true } : { admin: true, push: true },
              },
            };
          }
          if (path === '/repos/team/new/collaborators/bob/permission') {
            return { status: 200, body: { permission: 'write' } };
          }
          if (path.startsWith('/repos/team/old')) {
            return { status: 200, body: { permissions: { admin: true, push: true } } };
          }
          return { status: 404 };
        }, calls),
      },
    );
    expect(await host.access('person', renamed)).toBe('admin');
    expect(await host.accessByBot('bob', renamed)).toBe('write');
    expect(await host.health(renamed)).toBe('ok');
    expect(calls.some((call) => call.includes('/repos/team/old'))).toBe(false);

    const gone = door((path) => (path === '/repositories/7' ? { status: 404 } : { status: 200 }));
    expect(await gone.accessByBot('bob', renamed)).toBe('refused:removed');
  });

  it('hands out only the limited token, and only for its repository', async () => {
    const host = door(() => ({ status: 404 }));
    expect(await host.tokenFor({ owner: 'Team', name: 'Wiki' })).toBe('limited');
    expect(await host.tokenFor({ owner: 'team', name: 'other' })).toBeUndefined();
  });

  it('checks the version, the bot being admin and the limited token at start (R17)', async () => {
    const healthy: Route = (path, token) => {
      if (path === '/version') return { status: 200, body: { version: '15.0.12+gitea-1.22.0' } };
      if (path === '/repos/team/wiki' && token === 'bot') {
        return { status: 200, body: { permissions: { admin: true, push: true } } };
      }
      if (path === '/repos/team/wiki' && token === 'limited') {
        return { status: 200, body: { permissions: { admin: false, push: true } } };
      }
      return { status: 404 };
    };
    expect(await door(healthy).selfCheck()).toEqual({ ok: true });

    const old = await door((path, token) =>
      path === '/version' ? { status: 200, body: { version: '14.0.3' } } : healthy(path, token),
    ).selfCheck();
    expect(old.ok).toBe(false);
    expect(old.ok === false && old.problems.join(' ')).toContain('Forgejo 15 or later');

    const writer = await door((path, token) =>
      path === '/repos/team/wiki' && token === 'bot'
        ? { status: 200, body: { permissions: { push: true } } }
        : healthy(path, token),
    ).selfCheck();
    expect(writer.ok === false && writer.problems.join(' ')).toContain('must be an administrator');

    const down = await createForgejoDoorHost(
      { webUrl: 'https://git.example.org', apiUrl: API, repo },
      { fetch: (() => Promise.reject(new Error('down'))) as typeof fetch, botToken: () => 'bot' },
    ).selfCheck();
    expect(down).toMatchObject({ ok: false, unreachable: true });
  });

  it('reads the leading version number', () => {
    expect(forgejoMajorVersion('15.0.12+gitea-1.22.0')).toBe(15);
    expect(forgejoMajorVersion('v16.1.0')).toBe(16);
    expect(forgejoMajorVersion('1.22.0')).toBe(1);
    expect(forgejoMajorVersion('dev')).toBeUndefined();
  });
});
