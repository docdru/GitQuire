import { describe, expect, it } from 'vitest';
import { createGitHubDoorHost } from './github.ts';

const repo = { owner: 'acme', name: 'notes' };

function host(fetchImpl: typeof fetch, installationToken: () => string | undefined = () => 'bot') {
  return createGitHubDoorHost(
    {
      webUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      repo,
    },
    { fetch: fetchImpl, installationToken },
  );
}

function answering(status: number, body: unknown, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push(`${init?.method ?? 'GET'} ${String(input)} ${headers.get('authorization') ?? ''}`);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('GitHub door host', () => {
  it('builds the authorize address as before', () => {
    const url = new URL(
      host(answering(200, {})).authorizeUrl({
        clientId: 'Iv1.client',
        redirectUri: 'https://wiki.example/auth/github/callback',
        state: 's',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'Iv1.client',
      redirect_uri: 'https://wiki.example/auth/github/callback',
      state: 's',
      allow_signup: 'false',
    });
  });

  it('reads the person and their access with the sign-in token', async () => {
    const calls: string[] = [];
    const person = await host(
      answering(200, { id: 3, login: 'bob', name: ' ', avatar_url: 'https://a/3' }, calls),
    ).person('t');
    expect(person).toEqual({ id: 3, login: 'bob', name: 'bob', avatarUrl: 'https://a/3' });
    expect(calls).toEqual(['GET https://api.github.com/user Bearer t']);
    expect(await host(answering(200, { permissions: { push: true } })).access('t', repo)).toBe(
      'write',
    );
    expect(await host(answering(200, { permissions: { maintain: true } })).access('t', repo)).toBe(
      'admin',
    );
    expect(await host(answering(200, { permissions: { pull: true } })).access('t', repo)).toBe(
      'none',
    );
    expect(await host(answering(404, {})).access('t', repo)).toBe('none');
  });

  it('asks for the person’s access by repository id when the wiki record carries one', async () => {
    const calls: string[] = [];
    const answer = answering(200, { permissions: { admin: true } }, calls);
    expect(await host(answer).access('t', { ...repo, id: 42 })).toBe('admin');
    expect(calls).toEqual(['GET https://api.github.com/repositories/42 Bearer t']);
  });

  it('asks for a collaborator role with the bot token and tells refused from unreachable', async () => {
    const calls: string[] = [];
    expect(
      await host(answering(200, { permission: 'write', role_name: 'maintain' }, calls)).accessByBot(
        'bob',
        repo,
      ),
    ).toBe('admin');
    expect(calls).toEqual([
      'GET https://api.github.com/repos/acme/notes/collaborators/bob/permission Bearer bot',
    ]);
    expect(await host(answering(200, { permission: 'write' })).accessByBot('bob', repo)).toBe(
      'write',
    );
    expect(await host(answering(200, { role_name: 'triage' })).accessByBot('bob', repo)).toBe(
      'none',
    );
    expect(await host(answering(404, {})).accessByBot('bob', repo)).toBe('none');
    expect(await host(answering(401, {})).accessByBot('bob', repo)).toBe('refused:token');
    expect(await host(answering(403, {})).accessByBot('bob', repo)).toBe('refused:not-admin');
    expect(await host(answering(502, {})).accessByBot('bob', repo)).toBe('unreachable');
    const offline = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    expect(await host(offline).accessByBot('bob', repo)).toBe('unreachable');
    expect(await host(answering(200, {}), () => undefined).accessByBot('bob', repo)).toBe(
      'unreachable',
    );
  });

  it('hands out the installation token only for its own repository', async () => {
    const door = host(answering(200, {}));
    expect(await door.tokenFor({ owner: 'ACME', name: 'Notes' })).toBe('bot');
    expect(await door.tokenFor({ owner: 'acme', name: 'other' })).toBeUndefined();
  });
});

describe('GitHub door host: rate limits and repo ids', () => {
  const app = { jwt: () => 'jwt' };

  function host(answer: (method: string, path: string, body: string) => Response) {
    const seen: string[] = [];
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === 'string' ? init.body : '';
      seen.push(`${init?.method ?? 'GET'} ${url.pathname} ${body}`.trim());
      return answer(init?.method ?? 'GET', url.pathname, body);
    };
    const door = createGitHubDoorHost(
      { webUrl: 'https://github.com', apiUrl: 'https://api.github.com', repo: undefined },
      { fetch: fake as typeof fetch, app },
    );
    return { door, seen };
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it('reads 429 and rate-limited 403 answers as unreachable, not as refused (R14)', async () => {
    for (const limited of [
      json(429, { message: 'slow down' }),
      json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }),
      json(403, { message: 'You have exceeded a secondary rate limit.' }),
      json(403, { message: 'wait' }, { 'retry-after': '60' }),
    ]) {
      const { door } = host((method, path) => {
        if (path.endsWith('/installation')) return json(200, { id: 11 });
        if (method === 'POST') return json(201, { token: 't', expires_at: '2999-01-01T00:00:00Z' });
        return limited.clone();
      });
      expect(await door.accessByBot('alice', { owner: 'acme', name: 'notes' })).toBe('unreachable');
    }
    const { door } = host((method, path) => {
      if (path.endsWith('/installation')) return json(200, { id: 11 });
      if (method === 'POST') return json(201, { token: 't', expires_at: '2999-01-01T00:00:00Z' });
      return json(403, { message: 'Must have push access to view collaborator permission.' });
    });
    expect(await door.accessByBot('alice', { owner: 'acme', name: 'notes' })).toBe(
      'refused:not-admin',
    );
    const { door: health } = host(() => json(429, {}));
    expect(await health.health({ owner: 'acme', name: 'notes' })).toBe('unreachable');
  });

  it('mints by repository id when the repo record carries one, so a reused old name cannot get the token', async () => {
    const { door, seen } = host((method, path) => {
      if (path === '/repositories/41/installation') return json(200, { id: 11 });
      if (method === 'POST') return json(201, { token: 't', expires_at: '2999-01-01T00:00:00Z' });
      return json(200, { permission: 'write', role_name: 'write' });
    });
    const record = { host: 'github' as const, id: 41, owner: 'acme', ownerId: 7, name: 'notes' };
    expect(await door.tokenFor(record)).toBe('t');
    expect(await door.accessByBot('alice', record)).toBe('write');
    expect(seen).toEqual([
      'GET /repositories/41/installation',
      'POST /app/installations/11/access_tokens {"repository_ids":[41]}',
      'GET /repositories/41/collaborators/alice/permission',
    ]);
  });
});
