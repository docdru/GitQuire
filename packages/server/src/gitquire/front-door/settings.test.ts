import { describe, expect, it } from 'vitest';
import { FrontDoorConfigError, resolveFrontDoorSettings, wikisModeFromEnv } from './settings.ts';

const PEM = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';

const github = {
  GITQUIRE_WIKIS: 'on',
  GITHUB_APP_CLIENT_ID: 'id',
  GITHUB_APP_CLIENT_SECRET: 'secret',
  GITHUB_APP_ID: '7',
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITQUIRE_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  GITQUIRE_EXTERNAL_URL: 'https://wiki.example.org',
  GITQUIRE_REPO: 'Team/wiki',
};

const forgejo = {
  GITQUIRE_WIKIS: 'on',
  GITQUIRE_HOST: 'forgejo',
  GITQUIRE_HOST_URL: 'https://code.example.org',
  GITQUIRE_HOST_CLIENT_ID: 'id',
  GITQUIRE_HOST_CLIENT_SECRET: 'secret',
  GITQUIRE_HOST_TOKEN: 'bot',
  GITQUIRE_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  GITQUIRE_EXTERNAL_URL: 'https://wiki.example.org',
  GITQUIRE_ALLOWED_OWNERS: 'team, @Docs',
};

describe('front door settings', () => {
  it('is on only for an on value', () => {
    expect(wikisModeFromEnv({})).toBe(false);
    expect(wikisModeFromEnv({ GITQUIRE_WIKIS: 'off' })).toBe(false);
    expect(wikisModeFromEnv({ GITQUIRE_WIKIS: ' ON ' })).toBe(true);
    expect(wikisModeFromEnv({ GITQUIRE_WIKIS: ' ' })).toBe(false);
    expect(() => wikisModeFromEnv({ GITQUIRE_WIKIS: 'maybe' })).toThrow(/must be on or off/);
  });

  it('takes the owner of GITQUIRE_REPO as the only allowed owner when none is listed (R18)', () => {
    const settings = resolveFrontDoorSettings(github, '/data');
    expect([...settings.allowedOwners]).toEqual(['team']);
    expect(settings.defaultWiki).toEqual({ owner: 'Team', name: 'wiki' });
    expect(settings.githubApp?.appId).toBe('7');
    expect(settings.forgejoBotToken).toBeUndefined();
  });

  it('reads the agent settings, and still refuses GITQUIRE_MCP_TOKEN (R7)', () => {
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
    expect(() =>
      resolveFrontDoorSettings({ ...github, GITQUIRE_MCP_TOKEN: 'shared' }, '/data'),
    ).toThrow(/GITQUIRE_MCP_TOKEN cannot be used with GITQUIRE_WIKIS=on/);
  });

  it('refuses to start without allowed owners or GITQUIRE_REPO and says which to set', () => {
    const { GITQUIRE_REPO: _repo, ...env } = github;
    expect(() => resolveFrontDoorSettings(env, '/data')).toThrow(
      /GITQUIRE_ALLOWED_OWNERS .* or GITQUIRE_REPO/,
    );
  });

  it.each(['GITQUIRE_ALLOWED_USERS', 'GITQUIRE_MCP_TOKEN'])(
    'refuses %s in several-wiki mode (R7)',
    (name) => {
      expect(() => resolveFrontDoorSettings({ ...github, [name]: 'x' }, '/data')).toThrow(
        new RegExp(`${name} cannot be used with GITQUIRE_WIKIS=on`),
      );
    },
  );

  it('reads the Forgejo bot token and the listed owners', () => {
    const settings = resolveFrontDoorSettings(forgejo, '/data');
    expect(settings.host).toBe('forgejo');
    expect(settings.forgejoBotToken).toBe('bot');
    expect([...settings.allowedOwners].sort()).toEqual(['docs', 'team']);
    expect(settings.apiUrl).toBe('https://code.example.org/api/v1');
    expect(settings.githubApp).toBeUndefined();
  });

  it('names every missing setting', () => {
    expect(() =>
      resolveFrontDoorSettings({ GITQUIRE_WIKIS: 'on', GITQUIRE_REPO: 'a/b' }, '/data'),
    ).toThrow(
      /GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITQUIRE_SESSION_SECRET, GITQUIRE_EXTERNAL_URL, GITHUB_APP_ID/,
    );
    expect(() =>
      resolveFrontDoorSettings({ ...forgejo, GITQUIRE_HOST_TOKEN: '' }, '/data'),
    ).toThrow(/GITQUIRE_HOST_TOKEN/);
  });

  it('wants the external address without a path and Forgejo over https', () => {
    expect(() =>
      resolveFrontDoorSettings({ ...github, GITQUIRE_EXTERNAL_URL: 'https://x.org/wiki' }, '/data'),
    ).toThrow(FrontDoorConfigError);
    expect(() =>
      resolveFrontDoorSettings(
        { ...forgejo, GITQUIRE_HOST_URL: 'http://code.example.org' },
        '/data',
      ),
    ).toThrow(/https/);
  });
});
