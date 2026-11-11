import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAppJwt,
  createGitHubAppClient,
  type GitHubAppClient,
  type GitHubAppConfig,
  GitHubUnavailableError,
  resolveGitHubAppConfig,
  retryWhileUnavailable,
  startInstallationTokenManager,
} from './github-app.ts';
import {
  authHeaderEnv,
  basicAuthHeader,
  bootstrapRepository,
  ensureAutoSyncMode,
  parseAutoSyncMode,
} from './repo-bootstrap.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const CONFIG: GitHubAppConfig = {
  appId: '12345',
  privateKeyPem: privateKey,
  repo: { owner: 'acme', name: 'notes' },
  branch: undefined,
  githubApiUrl: 'https://api.github.com',
  gitHost: 'github.com',
};

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('resolveGitHubAppConfig', () => {
  it('stays off without any app settings', () => {
    expect(resolveGitHubAppConfig({})).toBeUndefined();
  });

  it('names missing settings', () => {
    expect(() => resolveGitHubAppConfig({ GITHUB_APP_ID: '1' })).toThrow(
      'GITHUB_APP_PRIVATE_KEY_FILE (or GITHUB_APP_PRIVATE_KEY), GITQUIRE_REPO',
    );
  });

  it('accepts an inline key with escaped newlines', () => {
    const config = resolveGitHubAppConfig({
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
      GITQUIRE_REPO: 'acme/notes',
      GITQUIRE_BRANCH: 'wiki',
    });
    expect(config?.privateKeyPem).toBe(privateKey);
    expect(config?.branch).toBe('wiki');
  });

  it('reads the key from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gq-key-'));
    const file = join(dir, 'app.pem');
    writeFileSync(file, privateKey);
    const config = resolveGitHubAppConfig({
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY_FILE: file,
      GITQUIRE_REPO: 'acme/notes',
    });
    expect(config?.privateKeyPem).toBe(privateKey);
  });

  it('rejects something that is not a PEM key', () => {
    expect(() =>
      resolveGitHubAppConfig({
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'not a key',
        GITQUIRE_REPO: 'acme/notes',
      }),
    ).toThrow('not a PEM file');
  });
});

describe('createAppJwt', () => {
  it('signs an RS256 app token GitHub accepts', () => {
    const jwt = createAppJwt('12345', privateKey, NOW);
    const [header, payload, signature] = jwt.split('.');
    expect(decodePart(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decodePart(payload);
    expect(claims.iss).toBe('12345');
    expect(claims.iat).toBe(NOW / 1000 - 60);
    expect(claims.exp).toBe(NOW / 1000 + 540);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

interface Call {
  url: string;
  method: string;
  auth: string;
  body: string | undefined;
}

function appFetch(calls: Call[], installed = true): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: headers.Authorization ?? '',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url === 'https://api.github.com/repos/acme/notes/installation') {
      return installed
        ? new Response(JSON.stringify({ id: 777 }), { status: 200 })
        : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    if (url === 'https://api.github.com/app/installations/777/access_tokens') {
      return new Response(
        JSON.stringify({ token: 'ghs_install', expires_at: '2026-11-11T13:00:00Z' }),
        { status: 201 },
      );
    }
    if (url === 'https://api.github.com/repos/acme/notes') {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

describe('createGitHubAppClient', () => {
  it('mints an installation token scoped to the repo', async () => {
    const calls: Call[] = [];
    const client = createGitHubAppClient(CONFIG, { fetch: appFetch(calls), now: () => NOW });
    const minted = await client.mintInstallationToken();
    expect(minted).toEqual({ token: 'ghs_install', expiresAt: Date.UTC(2026, 10, 11, 13, 0, 0) });
    expect(calls[0].auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(calls[1].method).toBe('POST');
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ repositories: ['notes'] });
  });

  it('explains when the app is not installed on the repo', async () => {
    const client = createGitHubAppClient(CONFIG, { fetch: appFetch([], false), now: () => NOW });
    await expect(client.mintInstallationToken()).rejects.toThrow(
      'is not installed on acme/notes (HTTP 404: Not Found)',
    );
  });

  it('reads the default branch with the installation token', async () => {
    const calls: Call[] = [];
    const client = createGitHubAppClient(CONFIG, { fetch: appFetch(calls), now: () => NOW });
    expect(await client.repoInfo('ghs_install')).toEqual({
      defaultBranch: 'main',
      cloneUrl: 'https://github.com/acme/notes.git',
    });
    expect(calls[0].auth).toBe('Bearer ghs_install');
  });
});

function fakeClient(tokens: Array<{ token: string; expiresAt: number } | Error>): GitHubAppClient {
  let index = 0;
  return {
    async mintInstallationToken() {
      const next = tokens[Math.min(index, tokens.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    async repoInfo() {
      return { defaultBranch: 'main', cloneUrl: 'https://github.com/acme/notes.git' };
    },
  };
}

describe('startInstallationTokenManager', () => {
  it('serves the token for github.com and defers other hosts', async () => {
    const manager = await startInstallationTokenManager(
      CONFIG,
      fakeClient([{ token: 'ghs_one', expiresAt: NOW + 3_600_000 }]),
      { log: silentLog, now: () => NOW, setTimer: () => ({}) },
    );
    const detect = manager.wrapDetectGh((host) =>
      host === 'git.example.com' ? { available: true, token: 'fallback' } : { available: false },
    );
    expect(detect('github.com')).toEqual({ available: true, token: 'ghs_one' });
    expect(detect(undefined)).toEqual({ available: true, token: 'ghs_one' });
    expect(detect('git.example.com')).toEqual({ available: true, token: 'fallback' });
  });

  it('refreshes ten minutes before expiry and retries after a failure', async () => {
    let clock = NOW;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const manager = await startInstallationTokenManager(
      CONFIG,
      fakeClient([
        { token: 'ghs_one', expiresAt: NOW + 3_600_000 },
        new Error('GitHub down'),
        { token: 'ghs_two', expiresAt: NOW + 7_200_000 },
      ]),
      {
        log: silentLog,
        now: () => clock,
        setTimer: (fn, ms) => {
          timers.push({ fn, ms });
          return {};
        },
      },
    );
    expect(timers[0].ms).toBe(50 * 60 * 1000);

    clock = NOW + 50 * 60 * 1000;
    timers[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers[1].ms).toBe(60 * 1000);
    expect(manager.current()).toBe('ghs_one');

    clock += 60 * 1000;
    timers[1].fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.current()).toBe('ghs_two');
  });

  it('stops serving an expired token', async () => {
    let clock = NOW;
    const manager = await startInstallationTokenManager(
      CONFIG,
      fakeClient([{ token: 'ghs_one', expiresAt: NOW + 1000 }]),
      { log: silentLog, now: () => clock, setTimer: () => ({}) },
    );
    clock = NOW + 2000;
    expect(manager.current()).toBeUndefined();
    expect(manager.wrapDetectGh(undefined)('github.com')).toEqual({ available: false });
  });
});

describe('bootstrapRepository', () => {
  const client = fakeClient([{ token: 'ghs_boot', expiresAt: NOW + 3_600_000 }]);
  const authEnv = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: basicAuthHeader('ghs_boot'),
  };

  it('builds the auth header for git from the token', () => {
    expect(authHeaderEnv('github.com', 'ghs_boot')).toEqual(authEnv);
    expect(basicAuthHeader('ghs_boot')).toBe(
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_boot').toString('base64')}`,
    );
  });

  it('clones the default branch with the token only in the git environment', async () => {
    const calls: Array<{ args: string[]; env: unknown }> = [];
    const outcome = await bootstrapRepository('/data', CONFIG, client, {
      exists: () => false,
      runGit: (args, _cwd, env) => {
        calls.push({ args: [...args], env });
        return args.includes('ls-remote') ? 'abc123\trefs/heads/main\n' : '';
      },
    });
    expect(outcome).toEqual({ action: 'cloned', branch: 'main' });
    expect(calls).toEqual([
      { args: ['init', '--initial-branch', 'main'], env: undefined },
      { args: ['remote', 'add', 'origin', 'https://github.com/acme/notes.git'], env: undefined },
      { args: ['ls-remote', '--heads', 'origin', 'main'], env: authEnv },
      {
        args: ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        env: authEnv,
      },
      { args: ['checkout', '-B', 'main', '--track', 'origin/main'], env: undefined },
    ]);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain('ghs_boot');
    expect(calls.some((call) => call.args[0] === 'config')).toBe(false);
  });

  it('uses GITQUIRE_BRANCH when set', async () => {
    const calls: string[][] = [];
    await bootstrapRepository('/data', { ...CONFIG, branch: 'wiki' }, client, {
      exists: () => false,
      runGit: (args) => {
        calls.push([...args]);
        return args.includes('ls-remote') ? 'abc\trefs/heads/wiki\n' : '';
      },
    });
    expect(calls[0]).toEqual(['init', '--initial-branch', 'wiki']);
  });

  it('starts the branch locally when the repo is empty', async () => {
    const outcome = await bootstrapRepository('/data', CONFIG, client, {
      exists: () => false,
      runGit: () => '',
    });
    expect(outcome).toEqual({ action: 'initialized-empty', branch: 'main' });
  });

  it('keeps an existing checkout and points origin at the repo', async () => {
    const calls: string[][] = [];
    const outcome = await bootstrapRepository('/data', CONFIG, client, {
      exists: () => true,
      runGit: (args) => {
        calls.push([...args]);
        if (args[0] === 'remote' && args.length === 1) return 'origin\n';
        if (args[0] === 'symbolic-ref') return 'main\n';
        return '';
      },
    });
    expect(outcome).toEqual({ action: 'existing', branch: 'main' });
    expect(calls).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/acme/notes.git',
    ]);
  });
});

describe('retrying while GitHub is unavailable', () => {
  const noSleep = { sleep: async () => {} };

  it('retries outages and 5xx answers, then succeeds', async () => {
    let attempts = 0;
    const retries: number[] = [];
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      if (attempts === 2) return new Response('{}', { status: 502 });
      return appFetch([])(input, init);
    }) as typeof fetch;
    const client = createGitHubAppClient(CONFIG, {
      fetch: flaky,
      now: () => NOW,
      retry: { ...noSleep, onRetry: (_err, attempt) => retries.push(attempt) },
    });
    expect((await client.mintInstallationToken()).token).toBe('ghs_install');
    expect(retries).toEqual([1, 2]);
  });

  it('does not retry configuration errors', async () => {
    let attempts = 0;
    const counting = (async (input: string | URL | Request, init?: RequestInit) => {
      attempts += 1;
      return appFetch([], false)(input, init);
    }) as typeof fetch;
    const client = createGitHubAppClient(CONFIG, {
      fetch: counting,
      now: () => NOW,
      retry: noSleep,
    });
    await expect(client.mintInstallationToken()).rejects.toThrow('is not installed');
    expect(attempts).toBe(1);
  });

  it('gives up after the last delay', async () => {
    let attempts = 0;
    await expect(
      retryWhileUnavailable(
        async () => {
          attempts += 1;
          throw new GitHubUnavailableError('down');
        },
        { delaysMs: [1, 1], ...noSleep },
      ),
    ).rejects.toThrow('down');
    expect(attempts).toBe(3);
  });

  it('derives the git host from GITQUIRE_GITHUB_WEB_URL', () => {
    const config = resolveGitHubAppConfig({
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITQUIRE_REPO: 'acme/notes',
      GITQUIRE_GITHUB_WEB_URL: 'https://github.example.com/',
    });
    expect(config?.gitHost).toBe('github.example.com');
  });
});

describe('auto-sync mode', () => {
  it('parses the mode with full as the default', () => {
    expect(parseAutoSyncMode(undefined)).toBe('full');
    expect(parseAutoSyncMode('Follow')).toBe('follow');
    expect(() => parseAutoSyncMode('sometimes')).toThrow('GITQUIRE_SYNC_MODE');
  });

  it('writes the mode once and keeps a later choice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gq-sync-'));
    const file = join(dir, '.ok', 'local', 'config.yml');
    expect(ensureAutoSyncMode(dir, 'full')).toBe('written');
    expect(readFileSync(file, 'utf8')).toBe('autoSync:\n  mode: full\n');
    expect(ensureAutoSyncMode(dir, 'off')).toBe('kept');
    expect(readFileSync(file, 'utf8')).toBe('autoSync:\n  mode: full\n');
  });

  it('appends to an existing local config without autoSync', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gq-sync-'));
    const file = join(dir, '.ok', 'local', 'config.yml');
    ensureAutoSyncMode(dir, 'full');
    writeFileSync(file, 'server:\n  port: 8080');
    expect(ensureAutoSyncMode(dir, 'follow')).toBe('written');
    expect(readFileSync(file, 'utf8')).toBe('server:\n  port: 8080\nautoSync:\n  mode: follow\n');
  });
});
