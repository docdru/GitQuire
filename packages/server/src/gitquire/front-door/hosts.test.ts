import { describe, expect, it } from 'vitest';
import { hostByKey, hostKeyOf, hostVariable } from './hosts.ts';
import { resolveFrontDoorSettings } from './settings.ts';

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
  GITQUIRE_ADMINS: 'alice',
};

const plusForgejo = {
  ...github,
  GITQUIRE_HOSTS: 'forgejo',
  GITQUIRE_HOST_FORGEJO_URL: 'https://code.example.org',
  GITQUIRE_HOST_FORGEJO_CLIENT_ID: 'fid',
  GITQUIRE_HOST_FORGEJO_CLIENT_SECRET: 'fsecret',
  GITQUIRE_HOST_FORGEJO_TOKEN: 'bot',
  GITQUIRE_HOST_FORGEJO_ALLOWED_OWNERS: 'lab',
  GITQUIRE_HOST_FORGEJO_ADMINS: 'carol',
};

const read = (files: Record<string, string>) => (path: string) => {
  const found = files[path];
  if (found === undefined) throw new Error('ENOENT');
  return found;
};

describe('the host list', () => {
  it('has only the first host, described as before, without GITQUIRE_HOSTS (S8)', () => {
    const settings = resolveFrontDoorSettings(github, '/data');
    expect(settings.hosts).toHaveLength(1);
    const [first] = settings.hosts;
    expect(first).toMatchObject({
      key: 'github',
      kind: 'github',
      label: 'GitHub',
      primary: true,
      webUrl: settings.webUrl,
      apiUrl: settings.apiUrl,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      githubApp: settings.githubApp,
    });
    expect(first?.allowedOwners).toBe(settings.allowedOwners);
    expect([...(first?.serverAdmins ?? [])]).toEqual(['alice']);
    expect(first?.names.idPrefix).toBe('github-');
    expect(first?.names.noreplyEmail({ id: 4, login: 'bo' })).toBe('4+bo@users.noreply.github.com');
  });

  it('adds a Forgejo host with its own lists, label, ids and mail addresses', () => {
    const settings = resolveFrontDoorSettings(plusForgejo, '/data');
    expect(settings.hosts.map((host) => host.key)).toEqual(['github', 'forgejo']);
    const forgejo = hostByKey(settings.hosts, 'forgejo');
    expect(forgejo).toMatchObject({
      kind: 'forgejo',
      label: 'Forgejo',
      primary: false,
      webUrl: 'https://code.example.org',
      apiUrl: 'https://code.example.org/api/v1',
      clientId: 'fid',
      clientSecret: 'fsecret',
      forgejoBotToken: 'bot',
      githubApp: undefined,
    });
    expect([...(forgejo?.allowedOwners ?? [])]).toEqual(['lab']);
    expect([...(forgejo?.serverAdmins ?? [])]).toEqual(['carol']);
    expect(forgejo?.names.idPrefix).toBe('forgejo-');
    expect(forgejo?.names.noreplyEmail({ id: 1, login: 'carol' })).toBe(
      'carol@noreply.code.example.org',
    );
    expect([...settings.allowedOwners]).toEqual(['team']);
    expect([...settings.serverAdmins]).toEqual(['alice']);
  });

  it('keys a second host of the same kind, labels it apart and prefixes its people with the key', () => {
    const settings = resolveFrontDoorSettings(
      {
        ...plusForgejo,
        GITQUIRE_HOSTS: 'forgejo, lab-2',
        GITQUIRE_HOST_LAB_2_KIND: 'forgejo',
        GITQUIRE_HOST_LAB_2_URL: 'https://lab.example.org/',
        GITQUIRE_HOST_LAB_2_CLIENT_ID: 'lid',
        GITQUIRE_HOST_LAB_2_CLIENT_SECRET_FILE: '/run/secret',
        GITQUIRE_HOST_LAB_2_TOKEN_FILE: '/run/token',
        GITQUIRE_HOST_LAB_2_ALLOWED_OWNERS: 'x',
      },
      '/data',
      read({ '/run/secret': 'lsecret\n', '/run/token': 'ltoken\n' }),
    );
    const lab = hostByKey(settings.hosts, 'lab-2');
    expect(lab).toMatchObject({
      label: 'Forgejo (lab-2)',
      webUrl: 'https://lab.example.org',
      clientSecret: 'lsecret',
      forgejoBotToken: 'ltoken',
    });
    expect(lab?.names.idPrefix).toBe('lab-2-');
    expect(lab?.serverAdmins.size).toBe(0);
  });

  it('adds a GitHub host to a Forgejo server with its own app', () => {
    const settings = resolveFrontDoorSettings(
      {
        GITQUIRE_WIKIS: 'on',
        GITQUIRE_HOST: 'forgejo',
        GITQUIRE_HOST_URL: 'https://code.example.org',
        GITQUIRE_HOST_CLIENT_ID: 'id',
        GITQUIRE_HOST_CLIENT_SECRET: 'secret',
        GITQUIRE_HOST_TOKEN: 'bot',
        GITQUIRE_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
        GITQUIRE_EXTERNAL_URL: 'https://wiki.example.org',
        GITQUIRE_ALLOWED_OWNERS: 'lab',
        GITQUIRE_HOSTS: 'github',
        GITQUIRE_HOST_GITHUB_CLIENT_ID: 'gid',
        GITQUIRE_HOST_GITHUB_CLIENT_SECRET: 'gsecret',
        GITQUIRE_HOST_GITHUB_APP_ID: '9',
        GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY_FILE: '/run/key.pem',
        GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS: 'Team',
      },
      '/data',
      read({ '/run/key.pem': PEM }),
    );
    expect(settings.host).toBe('forgejo');
    const gh = hostByKey(settings.hosts, 'github');
    expect(gh).toMatchObject({
      kind: 'github',
      webUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      githubApp: { appId: '9', privateKeyPem: PEM },
      forgejoBotToken: undefined,
    });
    expect([...(gh?.allowedOwners ?? [])]).toEqual(['team']);
  });

  it.each([
    [{ GITQUIRE_HOSTS: 'github' }, /the key of the first host/],
    [{ GITQUIRE_HOSTS: 'forgejo,forgejo' }, /twice/],
    [{ GITQUIRE_HOSTS: 'Lab_1' }, /not a host key/],
    [{ GITQUIRE_HOSTS: 'url' }, /mistaken for the first host's/],
    [{ GITQUIRE_HOSTS: 'api-two' }, /mistaken for the first host's/],
    [{ GITQUIRE_HOSTS: 'lab' }, /GITQUIRE_HOST_LAB_KIND must be github or forgejo/],
    [
      { GITQUIRE_HOSTS: 'github2', GITQUIRE_HOST_GITHUB2_KIND: 'gitlab' },
      /must be github or forgejo, got "gitlab"/,
    ],
    [
      { GITQUIRE_HOSTS: 'forgejo', GITQUIRE_HOST_FORGEJO_KIND: 'github' },
      /names the other kind of host/,
    ],
    [{ GITQUIRE_HOSTS: 'a,a-api' }, /would share the variable GITQUIRE_HOST_A_API_URL/],
  ])('refuses %j', (extra, message) => {
    expect(() => resolveFrontDoorSettings({ ...plusForgejo, ...extra }, '/data')).toThrow(message);
  });

  it('names every missing setting of a further host', () => {
    expect(() =>
      resolveFrontDoorSettings({ ...github, GITQUIRE_HOSTS: 'forgejo' }, '/data'),
    ).toThrow(
      'The host "forgejo" in GITQUIRE_HOSTS needs: GITQUIRE_HOST_FORGEJO_CLIENT_ID, GITQUIRE_HOST_FORGEJO_CLIENT_SECRET (or _FILE), GITQUIRE_HOST_FORGEJO_ALLOWED_OWNERS, GITQUIRE_HOST_FORGEJO_URL, GITQUIRE_HOST_FORGEJO_TOKEN (or _FILE).',
    );
  });

  it('sends tokens only over https and wants the root address of a Forgejo', () => {
    expect(() =>
      resolveFrontDoorSettings(
        { ...plusForgejo, GITQUIRE_HOST_FORGEJO_URL: 'http://code.example.org' },
        '/data',
      ),
    ).toThrow(/must start with https:\/\//);
    expect(() =>
      resolveFrontDoorSettings(
        { ...plusForgejo, GITQUIRE_HOST_FORGEJO_URL: 'https://example.org/forgejo' },
        '/data',
      ),
    ).toThrow(/root address/);
  });

  it('refuses two hosts with the same given label', () => {
    expect(() =>
      resolveFrontDoorSettings({ ...plusForgejo, GITQUIRE_HOST_FORGEJO_LABEL: 'github' }, '/data'),
    ).toThrow(/Two hosts are labelled "github"/);
  });

  it('names variables and record keys by the host key', () => {
    expect(hostVariable('lab-2', 'URL')).toBe('GITQUIRE_HOST_LAB_2_URL');
    expect(hostKeyOf({ host: 'forgejo' })).toBe('forgejo');
    expect(hostKeyOf({ host: 'forgejo', hostKey: 'lab-2' })).toBe('lab-2');
  });
});
