import { describe, expect, it } from 'vitest';
import { GitHubAppConfigError } from '../github-app.ts';
import { createForgejoRepoClient, resolveForgejoRepoConfig } from './forgejo-repo.ts';

const ENV = {
  GITQUIRE_HOST: 'forgejo',
  GITQUIRE_HOST_URL: 'https://git.example.org/',
  GITQUIRE_HOST_TOKEN: 'bot',
  GITQUIRE_HOST_REPO_TOKEN: 'limited',
  GITQUIRE_REPO: 'team/wiki',
};

describe('Forgejo repository settings', () => {
  it('stays off unless GITQUIRE_HOST is forgejo', () => {
    expect(resolveForgejoRepoConfig({})).toBeUndefined();
    expect(resolveForgejoRepoConfig({ GITQUIRE_HOST: 'github' })).toBeUndefined();
  });

  it('reads both tokens, the addresses and the repository', () => {
    expect(resolveForgejoRepoConfig(ENV)).toEqual({
      repo: { owner: 'team', name: 'wiki' },
      branch: undefined,
      webUrl: 'https://git.example.org',
      apiUrl: 'https://git.example.org/api/v1',
      gitHost: 'git.example.org',
      botToken: 'bot',
      repoToken: 'limited',
    });
    const fromFiles = resolveForgejoRepoConfig(
      {
        ...ENV,
        GITQUIRE_HOST_TOKEN: undefined,
        GITQUIRE_HOST_TOKEN_FILE: '/run/bot',
        GITQUIRE_HOST_API_URL: 'http://forgejo:3000/api/v1/',
      },
      { readFile: () => 'from-file\n' },
    );
    expect(fromFiles?.botToken).toBe('from-file');
    expect(fromFiles?.apiUrl).toBe('http://forgejo:3000/api/v1');
  });

  it('names every missing setting', () => {
    expect(() => resolveForgejoRepoConfig({ GITQUIRE_HOST: 'forgejo' })).toThrow(
      'GITQUIRE_HOST_URL, GITQUIRE_REPO, GITQUIRE_HOST_TOKEN (or GITQUIRE_HOST_TOKEN_FILE), GITQUIRE_HOST_REPO_TOKEN (or GITQUIRE_HOST_REPO_TOKEN_FILE)',
    );
  });

  it('lets a draft process start without the unlimited token', () => {
    const config = resolveForgejoRepoConfig(
      { ...ENV, GITQUIRE_HOST_TOKEN: undefined },
      { needBotToken: false },
    );
    expect(config?.botToken).toBeUndefined();
    expect(config?.repoToken).toBe('limited');
  });

  it('refuses one token for both jobs and a plain http address', () => {
    expect(() => resolveForgejoRepoConfig({ ...ENV, GITQUIRE_HOST_REPO_TOKEN: 'bot' })).toThrow(
      'two different tokens',
    );
    expect(() =>
      resolveForgejoRepoConfig({ ...ENV, GITQUIRE_HOST_URL: 'http://git.example.org' }),
    ).toThrow(GitHubAppConfigError);
    expect(() =>
      resolveForgejoRepoConfig({ ...ENV, GITQUIRE_HOST_URL: 'https://x.org/git' }),
    ).toThrow('not supported yet');
  });
});

describe('Forgejo repository client', () => {
  it('gives Git the limited token and clones from the web address', async () => {
    const config = resolveForgejoRepoConfig({ ...ENV, GITQUIRE_HOST_URL: 'https://x.org:3000' });
    if (config === undefined) throw new Error('expected a config');
    let auth: string | null = null;
    const client = createForgejoRepoClient(config, {
      now: () => 1000,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        auth = new Headers(init?.headers).get('authorization');
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
      }) as typeof fetch,
    });
    const minted = await client.mintInstallationToken();
    expect(minted.token).toBe('limited');
    expect(minted.contents).toBe('write');
    expect(minted.expiresAt).toBeGreaterThan(1000);
    expect(await client.repoInfo(minted.token)).toEqual({
      defaultBranch: 'main',
      cloneUrl: 'https://x.org:3000/team/wiki.git',
    });
    expect(auth).toBe('token limited');
  });
});
