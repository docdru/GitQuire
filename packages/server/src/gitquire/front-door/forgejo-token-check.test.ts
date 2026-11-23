import { describe, expect, it } from 'vitest';
import { createForgejoTokenScopeCheck } from './forgejo-token-check.ts';

const repo = { host: 'forgejo' as const, id: 5, owner: 'team', ownerId: 7, name: 'alpha' };

function check(routes: (token: string, path: string) => [number, unknown] | 'down') {
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = String(headers.Authorization).replace('token ', '');
    const answer = routes(token, `${url.pathname.replace('/api/v1', '')}${url.search}`);
    if (answer === 'down') throw new Error('offline');
    return new Response(JSON.stringify(answer[1]), { status: answer[0] });
  };
  return createForgejoTokenScopeCheck({
    apiUrl: 'https://code.example.org/api/v1',
    botToken: () => 'bot',
    fetch: fake as typeof fetch,
  });
}

const otherRepos = [
  { id: 5, name: 'alpha', owner: { login: 'team' } },
  { id: 6, name: 'beta', owner: { login: 'team' } },
];

describe('Forgejo token scope check (F10)', () => {
  it('accepts a token that cannot read its person and is refused on another repository the bot reaches', async () => {
    const result = await check((token, path) => {
      if (path === '/user') return token === 'bot' ? [200, { login: 'gitquire-bot' }] : [403, {}];
      if (path.startsWith('/user/repos')) return [200, otherRepos];
      if (path === '/repos/team/beta/contents') return [token === 'bot' ? 200 : 403, {}];
      return [404, {}];
    })(repo, 'limited');
    expect(result).toBe('limited');
  });

  it('refuses a token that can read its person, or that is not refused on another repository', async () => {
    const readsPerson = check((_token, path) =>
      path === '/user' ? [200, { login: 'mallory' }] : [404, {}],
    );
    expect(await readsPerson(repo, 'x')).toBe('not-limited');
    for (const probe of [200, 401]) {
      const reaches = check((token, path) => {
        if (path === '/user') return token === 'bot' ? [200, {}] : [403, {}];
        if (path.startsWith('/user/repos')) return [200, otherRepos];
        return [probe, []];
      });
      expect(await reaches(repo, 'x')).toBe('not-limited');
    }
  });

  it('accepts a token that gets not found on a repository of a person that the bot can read', async () => {
    const personRepos = [
      { id: 5, name: 'alpha', owner: { login: 'drueffer' } },
      { id: 6, name: 'beta', owner: { login: 'drueffer' } },
    ];
    const result = await check((token, path) => {
      if (path === '/user') return token === 'bot' ? [200, {}] : [403, {}];
      if (path.startsWith('/user/repos')) return [200, personRepos];
      if (path === '/repos/drueffer/beta/contents') return [token === 'bot' ? 200 : 404, {}];
      return [404, {}];
    })({ ...repo, owner: 'drueffer' }, 'limited');
    expect(result).toBe('limited');
  });

  it('cannot confirm the token when the bot gets not found on that repository too', async () => {
    const result = await check((token, path) => {
      if (path === '/user') return token === 'bot' ? [200, {}] : [403, {}];
      if (path.startsWith('/user/repos')) return [200, otherRepos];
      return [404, {}];
    })(repo, 'x');
    expect(result).toBe('cannot-confirm');
  });

  it('cannot confirm the token when the bot reaches no other repository', async () => {
    const only = check((token, path) => {
      if (path === '/user') return token === 'bot' ? [200, {}] : [403, {}];
      if (path.startsWith('/user/repos')) return [200, [otherRepos[0]]];
      return [404, {}];
    });
    expect(await only(repo, 'x')).toBe('cannot-confirm');
  });

  it('says unreachable when the host is down', async () => {
    expect(await check(() => 'down')(repo, 'x')).toBe('unreachable');
  });
});
