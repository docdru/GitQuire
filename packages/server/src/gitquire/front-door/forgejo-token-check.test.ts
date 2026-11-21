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
  it('accepts a token of the bot that is refused on another repository the bot reaches', async () => {
    const result = await check((token, path) => {
      if (path === '/user')
        return [200, { login: token === 'bot' ? 'gitquire-bot' : 'GitQuire-Bot' }];
      if (path.startsWith('/user/repos')) return [200, otherRepos];
      if (path === '/repos/team/beta/contents') return [token === 'bot' ? 200 : 403, {}];
      return [404, {}];
    })(repo, 'limited');
    expect(result).toBe('limited');
  });

  it('refuses a token that reaches another repository, belongs to someone else, or hides its owner', async () => {
    const unlimited = check((token, path) => {
      if (path === '/user') return [200, { login: 'gitquire-bot' }];
      if (path.startsWith('/user/repos')) return [200, otherRepos];
      return [token === 'x' ? 200 : 404, []];
    });
    expect(await unlimited(repo, 'x')).toBe('not-limited');
    const someoneElse = check((token, path) =>
      path === '/user' ? [200, { login: token === 'bot' ? 'gitquire-bot' : 'mallory' }] : [404, {}],
    );
    expect(await someoneElse(repo, 'x')).toBe('not-the-bot');
    const noScope = check((token, path) =>
      path === '/user'
        ? token === 'bot'
          ? [200, { login: 'gitquire-bot' }]
          : [403, {}]
        : [404, {}],
    );
    expect(await noScope(repo, 'x')).toBe('cannot-read-owner');
  });

  it('accepts the bot token limited only by what the bot reaches when it reaches no other repository', async () => {
    const only = check((_token, path) => {
      if (path === '/user') return [200, { login: 'gitquire-bot' }];
      if (path.startsWith('/user/repos')) return [200, [otherRepos[0]]];
      return [404, {}];
    });
    expect(await only(repo, 'x')).toBe('limited');
  });

  it('says unreachable when the host is down', async () => {
    expect(await check(() => 'down')(repo, 'x')).toBe('unreachable');
  });
});
