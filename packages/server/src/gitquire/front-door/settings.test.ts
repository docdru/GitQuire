import { describe, expect, it } from 'vitest';
import { oldSettingsIn } from './old-settings.ts';
import {
  FrontDoorConfigError,
  FrontDoorSetupNeeded,
  resolveFrontDoorSettings,
} from './settings.ts';

const PEM = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';

const common = {
  GITQUIRE_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  GITQUIRE_EXTERNAL_URL: 'https://wiki.example.org',
};

const github = {
  ...common,
  GITQUIRE_HOSTS: 'github',
  GITQUIRE_HOST_GITHUB_CLIENT_ID: 'id',
  GITQUIRE_HOST_GITHUB_CLIENT_SECRET: 'secret',
  GITQUIRE_HOST_GITHUB_APP_ID: '7',
  GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY: PEM,
  GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS: 'team',
};

const forgejo = {
  ...common,
  GITQUIRE_HOSTS: 'forgejo',
  GITQUIRE_HOST_FORGEJO_URL: 'https://code.example.org',
  GITQUIRE_HOST_FORGEJO_CLIENT_ID: 'id',
  GITQUIRE_HOST_FORGEJO_CLIENT_SECRET: 'secret',
  GITQUIRE_HOST_FORGEJO_TOKEN: 'bot',
  GITQUIRE_HOST_FORGEJO_ALLOWED_OWNERS: 'team, @Docs',
};

function setupNeeded(env: Record<string, string>): FrontDoorSetupNeeded {
  try {
    resolveFrontDoorSettings(env, '/data');
  } catch (err) {
    if (err instanceof FrontDoorSetupNeeded) return err;
    throw err;
  }
  throw new Error('expected the set-up to be needed');
}

describe('front door settings', () => {
  it('describes every host by GITQUIRE_HOST_<KEY>_…, with no first host', () => {
    const settings = resolveFrontDoorSettings(
      {
        ...github,
        ...forgejo,
        GITQUIRE_HOSTS: 'forgejo,github',
        GITQUIRE_HOST_GITHUB_ADMINS: 'alice',
      },
      '/data',
    );
    expect(settings.hosts.map((host) => host.key)).toEqual(['forgejo', 'github']);
    const [first, second] = settings.hosts;
    expect(first?.kind).toBe('forgejo');
    expect(first?.forgejoBotToken).toBe('bot');
    expect(first?.apiUrl).toBe('https://code.example.org/api/v1');
    expect([...(first?.allowedOwners ?? [])].sort()).toEqual(['docs', 'team']);
    expect(second?.githubApp?.appId).toBe('7');
    expect([...(second?.serverAdmins ?? [])]).toEqual(['alice']);
    expect(second?.names.idPrefix).toBe('github-');
    expect(first?.names.idPrefix).toBe('forgejo-');
  });

  it('reads the same host the same way in either order of GITQUIRE_HOSTS', () => {
    const both = { ...github, ...forgejo };
    const one = resolveFrontDoorSettings({ ...both, GITQUIRE_HOSTS: 'github,forgejo' }, '/data');
    const two = resolveFrontDoorSettings({ ...both, GITQUIRE_HOSTS: 'forgejo,github' }, '/data');
    const view = (hosts: typeof one.hosts) =>
      hosts
        .map(({ primary: _primary, names, ...rest }) => ({ ...rest, prefix: names.idPrefix }))
        .sort((a, b) => a.key.localeCompare(b.key));
    expect(view(one.hosts)).toEqual(view(two.hosts));
  });

  it('reads how long access answers are kept and how long an unused wiki keeps running', () => {
    const plain = resolveFrontDoorSettings(github, '/data');
    expect(plain.accessCheckMs).toBe(300_000);
    expect(plain.wikiIdleMs).toBe(30 * 60_000);
    const set = resolveFrontDoorSettings(
      { ...github, GITQUIRE_ACCESS_CHECK_SECONDS: '20', GITQUIRE_WIKI_IDLE_MINUTES: '1.5' },
      '/data',
    );
    expect(set.accessCheckMs).toBe(20_000);
    expect(set.wikiIdleMs).toBe(90_000);
    expect(() =>
      resolveFrontDoorSettings({ ...github, GITQUIRE_ACCESS_CHECK_SECONDS: '0' }, '/data'),
    ).toThrow(/GITQUIRE_ACCESS_CHECK_SECONDS must be a number of seconds between 1 and 3600/);
    expect(() =>
      resolveFrontDoorSettings({ ...github, GITQUIRE_WIKI_IDLE_MINUTES: 'soon' }, '/data'),
    ).toThrow(/GITQUIRE_WIKI_IDLE_MINUTES must be/);
  });

  it('reads the agent settings', () => {
    const plain = resolveFrontDoorSettings(github, '/data');
    expect(plain.agentTokenDays).toBe(90);
    expect(plain.mcpConnectors).toBe(false);
    const set = resolveFrontDoorSettings(
      { ...github, GITQUIRE_AGENT_TOKEN_DAYS: '30', GITQUIRE_MCP_CONNECTORS: 'on' },
      '/data',
    );
    expect(set.agentTokenDays).toBe(30);
    expect(set.mcpConnectors).toBe(true);
    expect(() =>
      resolveFrontDoorSettings({ ...github, GITQUIRE_AGENT_TOKEN_DAYS: '0' }, '/data'),
    ).toThrow(/GITQUIRE_AGENT_TOKEN_DAYS/);
  });

  it('needs allowed owners for every host', () => {
    const { GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS: _owners, ...env } = github;
    expect(setupNeeded(env).missing).toEqual(['GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS']);
  });

  it('names every missing setting, variable names only, for the set-up page', () => {
    expect(setupNeeded({}).missing).toEqual([
      'GITQUIRE_EXTERNAL_URL',
      'GITQUIRE_SESSION_SECRET',
      'GITQUIRE_HOSTS',
    ]);
    const missing = setupNeeded({ ...forgejo, GITQUIRE_HOST_FORGEJO_TOKEN: '' });
    expect(missing.missing).toEqual(['GITQUIRE_HOST_FORGEJO_TOKEN (or _FILE)']);
    expect(missing.hostKeys).toEqual(['forgejo']);
    expect(missing.message).not.toContain('secret');
    const partial = setupNeeded({ GITQUIRE_HOSTS: 'github' });
    expect(partial.missing).toEqual([
      'GITQUIRE_EXTERNAL_URL',
      'GITQUIRE_SESSION_SECRET',
      'GITQUIRE_HOST_GITHUB_CLIENT_ID',
      'GITQUIRE_HOST_GITHUB_CLIENT_SECRET (or _FILE)',
      'GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS',
      'GITQUIRE_HOST_GITHUB_APP_ID',
      'GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY_FILE (or GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY)',
    ]);
  });

  it('stops on a wrong value instead of showing the set-up page', () => {
    expect(() =>
      resolveFrontDoorSettings({ ...github, GITQUIRE_EXTERNAL_URL: 'https://x.org/wiki' }, '/data'),
    ).toThrow(FrontDoorConfigError);
    expect(() =>
      resolveFrontDoorSettings({ ...github, GITQUIRE_SESSION_SECRET: 'short' }, '/data'),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      resolveFrontDoorSettings(
        { ...forgejo, GITQUIRE_HOST_FORGEJO_URL: 'http://code.example.org' },
        '/data',
      ),
    ).toThrow(/https/);
  });
});

describe('old settings (O3)', () => {
  const old = {
    GITQUIRE_REPO: 'team/wiki',
    GITHUB_APP_CLIENT_ID: 'id',
    GITHUB_APP_CLIENT_SECRET: 'secret',
    GITHUB_APP_ID: '7',
    GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/app.pem',
    GITQUIRE_GITHUB_WEB_URL: 'https://github.example',
    GITQUIRE_ADMINS: 'alice',
    GITQUIRE_ALLOWED_OWNERS: 'team',
    GITQUIRE_ALLOWED_USERS: 'bob',
    GITQUIRE_MCP_TOKEN: 'shared',
    GITQUIRE_AUTH: 'off',
    GITQUIRE_BRANCH: 'wiki',
    GITQUIRE_SYNC_MODE: 'follow',
    GITQUIRE_COMMIT_EMAIL_FORMAT: '{login}@example.org',
  };

  it('refuses every old setting at once, each with its replacement, and no value', () => {
    let message = '';
    try {
      resolveFrontDoorSettings({ ...github, ...old }, '/data');
    } catch (err) {
      expect(err).toBeInstanceOf(FrontDoorConfigError);
      expect(err).not.toBeInstanceOf(FrontDoorSetupNeeded);
      message = (err as Error).message;
    }
    for (const name of Object.keys(old)) expect(message).toContain(`${name} →`);
    expect(message).toContain('GITHUB_APP_CLIENT_ID → GITQUIRE_HOST_GITHUB_CLIENT_ID');
    expect(message).toContain('GITQUIRE_GITHUB_WEB_URL → GITQUIRE_HOST_GITHUB_URL');
    expect(message).toContain('GITQUIRE_ADMINS → GITQUIRE_HOST_GITHUB_ADMINS');
    expect(message).toContain('GITQUIRE_REPO → removed');
    for (const value of ['secret', 'shared', '/run/secrets/app.pem']) {
      expect(message).not.toContain(value);
    }
  });

  it('names the Forgejo variables after the old GITQUIRE_HOST', () => {
    expect(
      oldSettingsIn({
        GITQUIRE_HOST: 'forgejo',
        GITQUIRE_HOST_URL: 'https://code.example.org',
        GITQUIRE_HOST_TOKEN_FILE: '/run/secrets/bot',
        GITQUIRE_HOST_REPO_TOKEN: 'x',
      }),
    ).toEqual([
      'GITQUIRE_HOST → list "forgejo" in GITQUIRE_HOSTS',
      'GITQUIRE_HOST_URL → GITQUIRE_HOST_FORGEJO_URL',
      'GITQUIRE_HOST_TOKEN_FILE → GITQUIRE_HOST_FORGEJO_TOKEN_FILE',
      "GITQUIRE_HOST_REPO_TOKEN → removed: a server administrator enters each wiki's token in the app",
    ]);
  });

  it('refuses an old setting even when it is empty, so a half-renamed file is noticed', () => {
    expect(() => resolveFrontDoorSettings({ ...github, GITQUIRE_REPO: '' }, '/data')).toThrow(
      /GITQUIRE_REPO → removed/,
    );
  });

  it('refuses old settings before saying what is missing', () => {
    expect(() => resolveFrontDoorSettings({ GITHUB_APP_ID: '7' }, '/data')).toThrow(
      /GITHUB_APP_ID → GITQUIRE_HOST_GITHUB_APP_ID/,
    );
  });
});

describe('trailing comments (C3)', () => {
  it('refuses a value that ends in a comment, naming the variable only', () => {
    expect(() =>
      resolveFrontDoorSettings(
        { ...github, GITQUIRE_MCP_CONNECTORS: 'on          # lets claude.ai connect' },
        '/data',
      ),
    ).toThrow(/GITQUIRE_MCP_CONNECTORS end in a comment.*line of their own/);
  });

  it('accepts a # that is part of a value', () => {
    const settings = resolveFrontDoorSettings(
      {
        ...github,
        GITQUIRE_CHAT_WEBHOOK_URL: 'https://chat.example.org/hook#room',
        GITQUIRE_GIT_NAME: 'Wiki bot #2',
      },
      '/data',
    );
    expect(settings.hosts).toHaveLength(1);
  });
});
