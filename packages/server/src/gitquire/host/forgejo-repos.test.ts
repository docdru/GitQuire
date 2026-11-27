import { describe, expect, it } from 'vitest';
import { createForgejoDoorHost, type ForgejoRepoTokens } from './forgejo.ts';

const API = 'https://git.example.org/api/v1';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = (path: string, token: string | undefined) => Reply;

function fetchFrom(route: Route, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(API, '');
    const token = new Headers(init?.headers).get('authorization')?.replace(/^token /, '');
    calls.push(`${path} ${token ?? '-'}`);
    const reply = route(path, token);
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  }) as typeof fetch;
}

function repoRecord(
  id: number,
  owner: string,
  ownerId: number,
  name: string,
  permissions: { admin: boolean; push: boolean },
) {
  return {
    id,
    owner: { id: ownerId, login: owner, full_name: '', avatar_url: 'https://a' },
    name,
    full_name: `${owner}/${name}`,
    private: true,
    default_branch: 'main',
    permissions: { ...permissions, pull: true },
  };
}

function door(route: Route, calls: string[] = [], repoTokens?: ForgejoRepoTokens) {
  return createForgejoDoorHost(
    { webUrl: 'https://git.example.org', apiUrl: API, repo: undefined },
    {
      fetch: fetchFrom(route, calls),
      botToken: () => 'bot',
      ...(repoTokens === undefined ? {} : { repoTokens }),
    },
  );
}

const tokens: ForgejoRepoTokens = {
  tokenFor: (repo) =>
    repo.name === 'wiki' ? 'limited-wiki' : repo.name === 'leak' ? 'bot' : undefined,
};

describe('Forgejo door host for several repositories', () => {
  it('asks with the bot token whether a user or organisation exists', async () => {
    const calls: string[] = [];
    const host = door((path) => {
      if (path === '/users/alice' || path === '/orgs/team') return { status: 200, body: {} };
      return { status: 404, body: {} };
    }, calls);
    expect(await host.accountExists?.('alice')).toBe('found');
    expect(await host.accountExists?.('team')).toBe('found');
    expect(await host.accountExists?.('docdur')).toBe('missing');
    expect(calls).toContain('/users/alice bot');
    expect(await door(() => ({ status: 401, body: {} })).accountExists?.('x')).toBe('unknown');
  });

  it('lists the person repos where the person is admin and the bot reaches the repo', async () => {
    const calls: string[] = [];
    const host = door((path, token) => {
      if (path === '/user/repos?limit=50&page=1' && token === 'person') {
        return {
          status: 200,
          headers: { 'x-total-count': '4' },
          body: [
            repoRecord(1, 'team', 7, 'wiki', { admin: true, push: true }),
            repoRecord(2, 'team', 7, 'notes', { admin: false, push: true }),
            repoRecord(3, 'alice', 2, 'own', { admin: true, push: true }),
            repoRecord(4, 'team', 7, 'writer-bot', { admin: true, push: true }),
          ],
        };
      }
      if (path === '/repositories/1' && token === 'bot') {
        return { status: 200, body: repoRecord(1, 'team', 7, 'wiki', { admin: true, push: true }) };
      }
      if (path === '/repositories/4' && token === 'bot') {
        return {
          status: 200,
          body: repoRecord(4, 'team', 7, 'writer-bot', { admin: false, push: true }),
        };
      }
      return { status: 404, body: { message: 'Not Found' } };
    }, calls);
    expect(await host.addableRepos('person')).toEqual({
      state: 'listed',
      repos: [
        { host: 'forgejo', id: 1, owner: 'team', ownerId: 7, name: 'wiki' },
        {
          host: 'forgejo',
          id: 4,
          owner: 'team',
          ownerId: 7,
          name: 'writer-bot',
          blocked: 'bot-not-admin',
        },
      ],
    });
    expect(calls).toEqual([
      '/user/repos?limit=50&page=1 person',
      '/repositories/1 bot',
      '/repositories/3 bot',
      '/repositories/4 bot',
    ]);
  });

  it('pages through the person repos until the total is reached or a page is empty', async () => {
    const full = Array.from({ length: 50 }, (_, i) =>
      repoRecord(100 + i, 'team', 7, `r${i}`, { admin: false, push: true }),
    );
    const calls: string[] = [];
    const host = door((path) => {
      if (path === '/user/repos?limit=50&page=1') return { status: 200, body: full };
      if (path === '/user/repos?limit=50&page=2') {
        return {
          status: 200,
          body: [repoRecord(9, 'team', 7, 'last', { admin: true, push: true })],
        };
      }
      if (path === '/user/repos?limit=50&page=3') return { status: 200, body: [] };
      if (path === '/repositories/9')
        return { status: 200, body: repoRecord(9, 'team', 7, 'last', { admin: true, push: true }) };
      return { status: 404 };
    }, calls);
    const answer = await host.addableRepos('person');
    expect(answer.state === 'listed' && answer.repos.map((r) => r.id)).toEqual([9]);
    expect(calls.filter((call) => call.startsWith('/user/repos'))).toHaveLength(3);
  });

  it('tells whose token was refused, and an unreachable host', async () => {
    expect(await door(() => ({ status: 401 })).addableRepos('person')).toEqual({
      state: 'refused',
      whose: 'person',
    });
    const botRevoked = door((path) =>
      path.startsWith('/user/repos')
        ? { status: 200, body: [repoRecord(1, 'team', 7, 'wiki', { admin: true, push: true })] }
        : { status: 401 },
    );
    expect(await botRevoked.addableRepos('person')).toEqual({
      state: 'refused',
      whose: 'gitquire',
    });
    expect(await door(() => ({ status: 502 })).addableRepos('person')).toEqual({
      state: 'unreachable',
    });
  });

  it('finds a repo by its id with the owner id (R10)', async () => {
    const host = door((path, token) =>
      path === '/repositories/1' && token === 'bot'
        ? {
            status: 200,
            body: repoRecord(1, 'team-renamed', 7, 'wiki2', { admin: true, push: true }),
          }
        : { status: 404, body: { message: 'Not Found' } },
    );
    expect(await host.repoById(1)).toEqual({
      state: 'found',
      repo: { host: 'forgejo', id: 1, owner: 'team-renamed', ownerId: 7, name: 'wiki2' },
    });
    expect(await host.repoById(2)).toEqual({ state: 'gone' });
    expect(await door(() => ({ status: 401 })).repoById(1)).toEqual({
      state: 'refused',
      refusal: 'token',
    });
    expect(await door(() => ({ status: 503 })).repoById(1)).toEqual({ state: 'unreachable' });
    const offline = createForgejoDoorHost(
      { webUrl: 'https://git.example.org', apiUrl: API, repo: undefined },
      { fetch: (() => Promise.reject(new Error('down'))) as typeof fetch, botToken: () => 'bot' },
    );
    expect(await offline.repoById(1)).toEqual({ state: 'unreachable' });
  });

  it('hands out the wiki own limited token from the store, never the unlimited one (R12)', async () => {
    const host = door(() => ({ status: 404 }), [], tokens);
    expect(await host.tokenFor({ owner: 'team', name: 'wiki' })).toBe('limited-wiki');
    expect(await host.tokenFor({ owner: 'team', name: 'leak' })).toBeUndefined();
    expect(await host.tokenFor({ owner: 'team', name: 'other' })).toBeUndefined();
  });

  it('answers the health of a wiki from the bot and the limited token (R11, R15, F9)', async () => {
    const wiki = { owner: 'team', name: 'wiki' };
    const healthy: Route = (path, token) => {
      if (path !== '/repos/team/wiki') return { status: 404 };
      if (token === 'bot')
        return { status: 200, body: repoRecord(1, 'team', 7, 'wiki', { admin: true, push: true }) };
      if (token === 'limited-wiki') {
        return {
          status: 200,
          body: repoRecord(1, 'team', 7, 'wiki', { admin: false, push: true }),
        };
      }
      return { status: 404 };
    };
    expect(await door(healthy, [], tokens).health(wiki)).toBe('ok');
    const botStatus = (status: number) =>
      door(
        (path, token) => (token === 'bot' ? { status } : healthy(path, token)),
        [],
        tokens,
      ).health(wiki);
    expect(await botStatus(404)).toBe('refused:removed');
    expect(await botStatus(401)).toBe('refused:token');
    expect(await botStatus(502)).toBe('unreachable');
    const writer = door(
      (path, token) =>
        token === 'bot'
          ? { status: 200, body: repoRecord(1, 'team', 7, 'wiki', { admin: false, push: true }) }
          : healthy(path, token),
      [],
      tokens,
    );
    expect(await writer.health(wiki)).toBe('refused:not-admin');
    const limitedRevoked = door(
      (path, token) => (token === 'limited-wiki' ? { status: 401 } : healthy(path, token)),
      [],
      tokens,
    );
    expect(await limitedRevoked.health(wiki)).toBe('refused:token');
    expect(await door(healthy, [], { tokenFor: () => undefined }).health(wiki)).toBe(
      'refused:token',
    );
  });

  it('keeps the one-wiki token when no store is given', async () => {
    const host = createForgejoDoorHost(
      { webUrl: 'https://git.example.org', apiUrl: API, repo: { owner: 'team', name: 'wiki' } },
      {
        fetch: fetchFrom(() => ({ status: 404 })),
        botToken: () => 'bot',
        repoToken: () => 'limited',
      },
    );
    expect(await host.tokenFor({ owner: 'team', name: 'wiki' })).toBe('limited');
    expect(await host.tokenFor({ owner: 'team', name: 'other' })).toBeUndefined();
  });
});
