import { describe, expect, it } from 'vitest';
import { primaryVerifiedAddress, withoutNoReply } from './account-address.ts';
import { createForgejoDoorHost } from './forgejo.ts';
import { createGitHubDoorHost } from './github.ts';
import { forgejoNames, gitHubNames } from './names.ts';

const repo = { owner: 'acme', name: 'notes' };

function answering(status: number, body: unknown, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push(`${String(input)} ${headers.get('authorization') ?? ''}`);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('the account address a host reports', () => {
  it('takes only the primary address the host marks as verified (P2)', () => {
    expect(
      primaryVerifiedAddress(200, [
        { email: 'old@example.org', primary: false, verified: true },
        { email: 'anna@example.org', primary: true, verified: true },
      ]),
    ).toEqual({ state: 'found', address: 'anna@example.org' });
    expect(
      primaryVerifiedAddress(200, [{ email: 'anna@example.org', primary: true, verified: false }]),
    ).toEqual({ state: 'none' });
    expect(
      primaryVerifiedAddress(200, [{ email: 'anna@example.org', primary: false, verified: true }]),
    ).toEqual({ state: 'none' });
    expect(
      primaryVerifiedAddress(200, [{ email: 'not an address', primary: true, verified: true }]),
    ).toEqual({ state: 'none' });
  });

  it('never takes a no-reply address (P2)', () => {
    expect(
      primaryVerifiedAddress(200, [
        { email: '7+anna@users.noreply.github.com', primary: true, verified: true },
      ]),
    ).toEqual({ state: 'none' });
    const forgejo = forgejoNames('{login}@noreply.git.example.org');
    expect(
      withoutNoReply({ state: 'found', address: 'anna@noreply.git.example.org' }, forgejo),
    ).toEqual({ state: 'none' });
    expect(withoutNoReply({ state: 'found', address: 'anna@example.org' }, forgejo)).toEqual({
      state: 'found',
      address: 'anna@example.org',
    });
    expect(
      withoutNoReply({ state: 'found', address: '7+a@users.noreply.github.com' }, gitHubNames()),
    ).toEqual({ state: 'none' });
  });

  it('skips GitHub no-reply addresses in any case', () => {
    expect(
      primaryVerifiedAddress(200, [
        { email: '7+Anna@Users.NoReply.GitHub.com', primary: true, verified: true },
      ]),
    ).toEqual({ state: 'none' });
  });

  it('counts a GitHub rate limit as an outage, not as a missing permission', async () => {
    const limited = (async () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      })) as typeof fetch;
    const github = createGitHubDoorHost(
      { webUrl: 'https://github.com', apiUrl: 'https://api.github.com', repo },
      { fetch: limited, installationToken: () => 'bot' },
    );
    expect(await github.accountAddress?.('t')).toEqual({ state: 'unreachable' });
  });

  it('tells a refusal from a host that cannot be reached', () => {
    expect(
      primaryVerifiedAddress(403, { message: 'Resource not accessible by integration' }),
    ).toEqual({ state: 'refused' });
    expect(primaryVerifiedAddress(401, {})).toEqual({ state: 'refused' });
    expect(primaryVerifiedAddress(502, {})).toEqual({ state: 'unreachable' });
    expect(primaryVerifiedAddress(200, { not: 'a list' })).toEqual({ state: 'unreachable' });
  });

  it('is asked of GitHub with the sign-in token; without the App permission there is none', async () => {
    const calls: string[] = [];
    const github = (status: number, body: unknown) =>
      createGitHubDoorHost(
        { webUrl: 'https://github.com', apiUrl: 'https://api.github.com', repo },
        { fetch: answering(status, body, calls), installationToken: () => 'bot' },
      );
    expect(
      await github(200, [
        { email: 'anna@example.org', primary: true, verified: true },
      ]).accountAddress?.('person-token'),
    ).toEqual({ state: 'found', address: 'anna@example.org' });
    expect(calls).toEqual(['https://api.github.com/user/emails?per_page=100 Bearer person-token']);
    expect(
      await github(403, { message: 'Resource not accessible by integration' }).accountAddress?.(
        't',
      ),
    ).toEqual({ state: 'refused' });
  });

  it('is asked of Forgejo with the read:user sign-in token', async () => {
    const calls: string[] = [];
    const forgejo = createForgejoDoorHost(
      { webUrl: 'https://git.example.org', apiUrl: 'https://git.example.org/api/v1', repo },
      {
        fetch: answering(
          200,
          [{ email: 'anna@example.org', primary: true, verified: true }],
          calls,
        ),
        botToken: () => 'bot',
        repoToken: () => 'limited',
      },
    );
    expect(await forgejo.accountAddress?.('person-token')).toEqual({
      state: 'found',
      address: 'anna@example.org',
    });
    expect(calls).toEqual(['https://git.example.org/api/v1/user/emails token person-token']);
  });
});
