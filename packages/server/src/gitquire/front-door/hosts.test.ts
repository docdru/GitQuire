import { describe, expect, it } from 'vitest';
import { hostByKey, hostKeyOf, hostVariable } from './hosts.ts';
import { resolveFrontDoorSettings } from './settings.ts';

const PEM = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';

const github = {
  GITQUIRE_HOSTS: 'github',
  GITQUIRE_HOST_GITHUB_CLIENT_ID: 'id',
  GITQUIRE_HOST_GITHUB_CLIENT_SECRET: 'secret',
  GITQUIRE_HOST_GITHUB_APP_ID: '7',
  GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY: PEM,
  GITQUIRE_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  GITQUIRE_EXTERNAL_URL: 'https://wiki.example.org',
  GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS: 'Team',
  GITQUIRE_HOST_GITHUB_ADMINS: 'alice',
};

const plusForgejo = {
  ...github,
  GITQUIRE_HOSTS: 'github,forgejo',
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
  it('describes a single host by its key, as any other host', () => {
    const settings = resolveFrontDoorSettings(github, '/data');
    expect(settings.hosts).toHaveLength(1);
    const [first] = settings.hosts;
    expect(first).toMatchObject({
      key: 'github',
      kind: 'github',
      label: 'GitHub',
      webUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      clientId: 'id',
      clientSecret: 'secret',
      githubApp: { appId: '7', privateKeyPem: PEM.trim() },
    });
    expect([...(first?.allowedOwners ?? [])]).toEqual(['team']);
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
  });

  it('keys a second host of the same kind, labels it apart and prefixes its people with the key', () => {
    const settings = resolveFrontDoorSettings(
      {
        ...plusForgejo,
        GITQUIRE_HOSTS: 'github, forgejo, lab-2',
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

  it('reads a GitHub host listed after a Forgejo host with its own app', () => {
    const settings = resolveFrontDoorSettings(
      {
        ...plusForgejo,
        GITQUIRE_HOSTS: 'forgejo,github',
        GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY: '',
        GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY_FILE: '/run/key.pem',
      },
      '/data',
      read({ '/run/key.pem': PEM }),
    );
    expect(settings.hosts.map((host) => host.key)).toEqual(['forgejo', 'github']);
    const gh = hostByKey(settings.hosts, 'github');
    expect(gh).toMatchObject({
      kind: 'github',
      webUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      githubApp: { appId: '7', privateKeyPem: PEM },
      forgejoBotToken: undefined,
    });
    expect([...(gh?.allowedOwners ?? [])]).toEqual(['team']);
  });

  it.each([
    [{ GITQUIRE_HOSTS: 'github,forgejo,github' }, /twice/],
    [{ GITQUIRE_HOSTS: 'Lab_1' }, /not a host key/],
    [{ GITQUIRE_HOSTS: 'url' }, /read like the old settings/],
    [{ GITQUIRE_HOSTS: 'api-two' }, /read like the old settings/],
    [{ GITQUIRE_HOSTS: 'github,lab' }, /GITQUIRE_HOST_LAB_KIND must be github or forgejo/],
    [
      { GITQUIRE_HOSTS: 'github,github2', GITQUIRE_HOST_GITHUB2_KIND: 'gitlab' },
      /must be github or forgejo, got "gitlab"/,
    ],
    [
      { GITQUIRE_HOSTS: 'github,forgejo', GITQUIRE_HOST_FORGEJO_KIND: 'github' },
      /names the other kind of host/,
    ],
    [{ GITQUIRE_HOSTS: 'github,a,a-api' }, /begins with "a-", the key of another host/],
    [{ GITQUIRE_HOSTS: 'github,forgejo,forgejo-2' }, /begins with "forgejo-"/],
    [{ GITQUIRE_HOSTS: 'github,github-lab' }, /begins with "github-"/],
    [{ GITQUIRE_HOSTS: 'github,agents' }, /already uses \/auth\/agents/],
    [
      { GITQUIRE_HOST_FORGEJO_URL: 'https://code.example.org/?x=1' },
      /plain address, without a user, query/,
    ],
    [
      { GITQUIRE_HOST_FORGEJO_URL: 'https://u:p@code.example.org' },
      /plain address, without a user, query/,
    ],
    [
      { GITQUIRE_HOST_FORGEJO_API_URL: 'http://code.example.org/api/v1' },
      /must start with https:\/\//,
    ],
    [
      {
        GITQUIRE_HOSTS: 'github,forgejo,lab',
        GITQUIRE_HOST_LAB_KIND: 'github',
        GITQUIRE_HOST_LAB_CLIENT_ID: 'x',
        GITQUIRE_HOST_LAB_CLIENT_SECRET: 'y',
        GITQUIRE_HOST_LAB_APP_ID: '1',
        GITQUIRE_HOST_LAB_APP_PRIVATE_KEY: PEM,
        GITQUIRE_HOST_LAB_ALLOWED_OWNERS: 'z',
      },
      /The hosts "github" and "lab" have the same address https:\/\/github.com/,
    ],
  ])('refuses %j', (extra, message) => {
    expect(() => resolveFrontDoorSettings({ ...plusForgejo, ...extra }, '/data')).toThrow(message);
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

  it('sends a host plain http only on this machine', () => {
    const local = resolveFrontDoorSettings(
      { ...plusForgejo, GITQUIRE_HOST_FORGEJO_URL: 'http://127.0.0.1:3000' },
      '/data',
    );
    expect(hostByKey(local.hosts, 'forgejo')?.apiUrl).toBe('http://127.0.0.1:3000/api/v1');
    expect(() =>
      resolveFrontDoorSettings(
        { ...plusForgejo, GITQUIRE_HOST_FORGEJO_URL: 'http://127.0.0.1.example.org' },
        '/data',
      ),
    ).toThrow(/must start with https:\/\//);
  });

  it('refuses two hosts with the same given label', () => {
    expect(() =>
      resolveFrontDoorSettings({ ...plusForgejo, GITQUIRE_HOST_FORGEJO_LABEL: 'github' }, '/data'),
    ).toThrow(/Two hosts are labelled "github"/);
  });

  it('sends a GitHub Enterprise host its own API address, not github.com', () => {
    const settings = resolveFrontDoorSettings(
      {
        ...plusForgejo,
        GITQUIRE_HOSTS: 'github,forgejo,ghe',
        GITQUIRE_HOST_GHE_KIND: 'github',
        GITQUIRE_HOST_GHE_URL: 'https://ghe.example.org/',
        GITQUIRE_HOST_GHE_CLIENT_ID: 'x',
        GITQUIRE_HOST_GHE_CLIENT_SECRET: 'y',
        GITQUIRE_HOST_GHE_APP_ID: '1',
        GITQUIRE_HOST_GHE_APP_PRIVATE_KEY: PEM.replaceAll('\n', '\\n'),
        GITQUIRE_HOST_GHE_ALLOWED_OWNERS: 'z',
      },
      '/data',
    );
    const ghe = hostByKey(settings.hosts, 'ghe');
    expect(ghe?.webUrl).toBe('https://ghe.example.org');
    expect(ghe?.apiUrl).toBe('https://ghe.example.org/api/v3');
    expect(ghe?.githubApp?.privateKeyPem).toBe(PEM);
  });

  it('says which secret file it could not read', () => {
    expect(() =>
      resolveFrontDoorSettings(
        {
          ...plusForgejo,
          GITQUIRE_HOST_FORGEJO_TOKEN: '',
          GITQUIRE_HOST_FORGEJO_TOKEN_FILE: '/run/missing',
        },
        '/data',
        read({}),
      ),
    ).toThrow('Could not read GITQUIRE_HOST_FORGEJO_TOKEN_FILE (/run/missing): ENOENT');
  });

  it('names variables and record keys by the host key', () => {
    expect(hostVariable('lab-2', 'URL')).toBe('GITQUIRE_HOST_LAB_2_URL');
    expect(hostKeyOf({ host: 'forgejo' })).toBe('forgejo');
    expect(hostKeyOf({ host: 'forgejo', hostKey: 'lab-2' })).toBe('lab-2');
  });
});
