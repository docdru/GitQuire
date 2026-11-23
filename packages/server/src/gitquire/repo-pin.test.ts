import { describe, expect, it } from 'vitest';
import { createRepoPin, parseRepoId, withGitConfig } from './repo-pin.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const origin = 'https://git.example.org/team/old.git';

function pinAnswering(answer: () => Response | Promise<Response>, seen: string[] = []) {
  return createRepoPin(
    {
      repoId: 7,
      repo: { owner: 'team', name: 'old' },
      apiUrl: 'https://git.example.org/api/v1',
      originUrl: () => origin,
    },
    {
      token: () => 'limited',
      log: silent,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`);
        return answer();
      }) as typeof fetch,
    },
  );
}

function repository(name: string, id = 7): Response {
  return new Response(JSON.stringify({ id, name, owner: { login: 'team' } }), { status: 200 });
}

describe('pinning a wiki’s Git remote to its repository id', () => {
  it('adds nothing while the repository with that id still has the wiki’s name', async () => {
    const seen: string[] = [];
    expect(await pinAnswering(() => repository('old'), seen).refresh()).toEqual([]);
    expect(seen).toEqual(['https://git.example.org/api/v1/repositories/7 token limited']);
  });

  it('sends fetch and push to the repository’s new name, never to a new repository under the old one', async () => {
    expect(await pinAnswering(() => repository('new')).refresh()).toEqual([
      `url.https://git.example.org/team/new.git.insteadOf=${origin}`,
    ]);
  });

  it('makes sync fail closed when the repository cannot be confirmed', async () => {
    const closed = [`url.gitquire-unconfirmed://repository-7/.insteadOf=${origin}`];
    expect(await pinAnswering(() => new Response('{}', { status: 404 })).refresh()).toEqual(closed);
    expect(await pinAnswering(() => new Response('{}', { status: 502 })).refresh()).toEqual(closed);
    expect(await pinAnswering(() => repository('old', 8)).refresh()).toEqual(closed);
    expect(
      await pinAnswering(() => {
        throw new Error('down');
      }).refresh(),
    ).toEqual(closed);
  });

  it('keeps its last answer for Git run outside the sync engine, closed until it has one', async () => {
    const pin = pinAnswering(() => repository('new'));
    expect(pin.current()).toEqual([`url.gitquire-unconfirmed://repository-7/.insteadOf=${origin}`]);
    await pin.refresh();
    expect(pin.current()).toEqual([`url.https://git.example.org/team/new.git.insteadOf=${origin}`]);
  });

  it('adds the rewrite after Git configuration already given in the environment', () => {
    expect(
      withGitConfig(
        { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'x' },
        ['url.a.insteadOf=b=c'],
      ),
    ).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: 'x',
      GIT_CONFIG_KEY_1: 'url.a.insteadOf',
      GIT_CONFIG_VALUE_1: 'b=c',
    });
    const env = { A: '1' };
    expect(withGitConfig(env, [])).toBe(env);
  });

  it('reads only a positive whole number as a repository id', () => {
    expect(parseRepoId('42')).toBe(42);
    expect(parseRepoId(' 7 ')).toBe(7);
    expect(parseRepoId(undefined)).toBeUndefined();
    expect(parseRepoId('0')).toBeUndefined();
    expect(parseRepoId('4e2')).toBeUndefined();
    expect(parseRepoId('team/old')).toBeUndefined();
  });
});
