import { describe, expect, it } from 'vitest';
import { createGitHubDoorHost } from './github.ts';
import { gitHubNames } from './names.ts';

const repo = { owner: 'acme', name: 'notes' };

function host(fetchImpl: typeof fetch, botToken: () => string | undefined = () => 'bot') {
  return createGitHubDoorHost(
    {
      names: gitHubNames(),
      webUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      repo,
    },
    { fetch: fetchImpl, botToken },
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
    expect(await host(answering(401, {})).accessByBot('bob', repo)).toBe('refused');
    expect(await host(answering(403, {})).accessByBot('bob', repo)).toBe('refused');
    expect(await host(answering(502, {})).accessByBot('bob', repo)).toBe('unreachable');
    const offline = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    expect(await host(offline).accessByBot('bob', repo)).toBe('unreachable');
    expect(await host(answering(200, {}), () => undefined).accessByBot('bob', repo)).toBe(
      'unreachable',
    );
  });

  it('hands out the bot token only for its own repository', () => {
    const door = host(answering(200, {}));
    expect(door.tokenFor({ owner: 'ACME', name: 'Notes' })).toBe('bot');
    expect(door.tokenFor({ owner: 'acme', name: 'other' })).toBeUndefined();
  });
});
