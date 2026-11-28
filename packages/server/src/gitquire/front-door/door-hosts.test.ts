import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostNamesFromEnv, resetHostNames } from '../host/names.ts';
import type { DoorHost } from '../host/types.ts';
import { createWikiAccess } from './access.ts';
import { entryForTest, hostSettingsForTest, hostsForTest } from './door-hosts.test-helper.ts';
import { doorHostPaths, personIdOn } from './door-hosts.ts';
import { wikiEnv } from './wiki-processes.ts';
import { openWikiTable, type WikiRecord } from './wiki-table.ts';

const dirs: string[] = [];
afterEach(() => {
  resetHostNames();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = {
  host: 'github' as const,
  webUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
  clientId: 'id',
  clientSecret: 'secret',
  githubApp: undefined,
  forgejoBotToken: undefined,
  allowedOwners: new Set(['team']),
  serverAdmins: new Set(['alice']),
};

const lab = hostSettingsForTest(base, {
  key: 'lab',
  kind: 'forgejo',
  label: 'Forgejo (lab)',
  primary: false,
  webUrl: 'https://lab.example.org',
  apiUrl: 'https://lab.example.org/api/v1',
  forgejoBotToken: 'bot',
  serverAdmins: new Set(['carol']),
  commitEmailFormat: '{login}@lab.example.org',
});

const anyHost = {} as DoorHost;
function entry(settings: typeof lab) {
  return entryForTest({
    settings,
    host: anyHost,
    access: createWikiAccess({ host: anyHost, runnable: () => true, refused: () => {} }),
    owners: { names: settings.allowedOwners, pinned: () => ({}), pin: () => {} },
  });
}

function wiki(extra: Partial<WikiRecord>): WikiRecord {
  return {
    host: 'github',
    id: 5,
    owner: 'team',
    ownerId: 7,
    name: 'wiki',
    key: 'github-5',
    state: 'on',
    formerNames: [],
    addedBy: 'a',
    addedAt: '',
    ...extra,
  };
}

describe('the hosts of the front door', () => {
  const hosts = hostsForTest(entry(hostSettingsForTest(base)), entry(lab));

  it('finds a wiki’s host by its key, and only when the kind matches', () => {
    expect(hosts.primary.key).toBe('github');
    expect(hosts.of(wiki({}))?.key).toBe('github');
    expect(hosts.of(wiki({ host: 'forgejo', hostKey: 'lab', key: 'lab-5' }))?.key).toBe('lab');
    expect(hosts.of(wiki({ host: 'forgejo', key: 'forgejo-5' }))).toBeUndefined();
    expect(hosts.of(wiki({ host: 'github', hostKey: 'lab' }))).toBeUndefined();
    expect(hosts.of(wiki({ host: 'forgejo', hostKey: 'gone' }))).toBeUndefined();
  });

  it('names sign-in addresses and person ids by the host key (S9)', () => {
    expect(doorHostPaths('lab')).toEqual({
      login: '/auth/lab/login',
      callback: '/auth/lab/callback',
      addWiki: '/auth/lab/add-wiki',
    });
    expect(personIdOn(lab.names, 4)).toBe('lab-4');
    expect(personIdOn(hosts.primary.names, 4)).toBe('github-4');
  });
});

describe('a wiki process of a further host', () => {
  const door = {
    PATH: '/bin',
    GITQUIRE_HOST: 'github',
    GITQUIRE_GITHUB_WEB_URL: 'https://github.com',
    GITQUIRE_ADMINS: 'alice',
    GITQUIRE_COMMIT_EMAIL_FORMAT: '{login}@example.org',
    GITQUIRE_NAMING: 'kebab',
  };
  const options = {
    externalUrl: new URL('https://wiki.example.org'),
    secret: 's'.repeat(64),
    tokenSocket: '/tmp/d/door.sock',
  };

  it('gets its own host, addresses, admins, mail format, key and label, never the first host’s', () => {
    const env = wikiEnv(door, wiki({ host: 'forgejo', hostKey: 'lab', key: 'lab-5' }), {
      ...options,
      host: lab,
    });
    expect(env).toMatchObject({
      GITQUIRE_HOST: 'forgejo',
      GITQUIRE_HOST_URL: 'https://lab.example.org',
      GITQUIRE_HOST_API_URL: 'https://lab.example.org/api/v1',
      GITQUIRE_HOST_KEY: 'lab',
      GITQUIRE_HOST_LABEL: 'Forgejo (lab)',
      GITQUIRE_ADMINS: 'carol',
      GITQUIRE_COMMIT_EMAIL_FORMAT: '{login}@lab.example.org',
      GITQUIRE_NAMING: 'kebab',
    });
    expect(env.GITQUIRE_GITHUB_WEB_URL).toBeUndefined();
    expect(Object.values(env)).not.toContain('bot');
    const names = hostNamesFromEnv(env);
    expect(names.idPrefix).toBe('lab-');
    expect(names.label).toBe('Forgejo (lab)');
    expect(names.noreplyEmail({ id: 1, login: 'carol' })).toBe('carol@lab.example.org');
  });

  it('describes the host of every wiki the same way, the GitHub host included', () => {
    const env = wikiEnv(door, wiki({}), { ...options, host: hostSettingsForTest(base) });
    expect(env).toMatchObject({
      GITQUIRE_HOST: 'github',
      GITQUIRE_GITHUB_WEB_URL: 'https://github.com',
      GITQUIRE_GITHUB_API_URL: 'https://api.github.com',
      GITQUIRE_HOST_KEY: 'github',
      GITQUIRE_HOST_LABEL: 'GitHub',
      GITQUIRE_ADMINS: 'alice',
    });
    expect(hostNamesFromEnv(env).idPrefix).toBe('github-');
  });

  it('reads the key only behind the front door', () => {
    expect(hostNamesFromEnv({ GITQUIRE_HOST_KEY: 'lab' }).idPrefix).toBe('github-');
    expect(() =>
      hostNamesFromEnv({ GITQUIRE_BEHIND_FRONT_DOOR: 'on', GITQUIRE_HOST_KEY: 'Bad key' }),
    ).toThrow(/not a host key/);
  });
});

describe('the wiki table with several hosts', () => {
  it('keys records by the host key and keeps pins per host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gq-table-'));
    dirs.push(dir);
    const file = join(dir, 'wikis.json');
    const table = openWikiTable(file);
    const repo = { host: 'forgejo' as const, id: 5, owner: 'team', ownerId: 7, name: 'wiki' };
    const first = table.add(repo, 'a', 0, 'forgejo');
    table.pinsOn('forgejo').pin('team', 7);
    expect(first.key).toBe('forgejo-5');
    expect(first.hostKey).toBeUndefined();
    const other = table.add(repo, 'a', 0, 'lab');
    expect(other).toMatchObject({ key: 'lab-5', hostKey: 'lab' });
    expect(table.byId('forgejo', 5)?.key).toBe('forgejo-5');
    expect(table.byId('lab', 5)?.key).toBe('lab-5');
    table.pinsOn('lab').pin('Team', 70);
    expect(table.pinsOn('forgejo').pinned()).toEqual({ team: 7 });
    expect(table.pinsOn('lab').pinned()).toEqual({ team: 70 });
    expect(openWikiTable(file).pinsOn('lab').pinned()).toEqual({ team: 70 });
  });

  it("reads the first host's pins of a table written by main without knowing which host was first (O1)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gq-table-'));
    dirs.push(dir);
    const file = join(dir, 'wikis.json');
    const record = (host: 'github' | 'forgejo', id: number, ownerId: number) => ({
      host,
      id,
      owner: 'team',
      ownerId,
      name: 'wiki',
      key: `${host}-${id}`,
      state: 'on',
      formerNames: [],
      addedBy: 'alice',
      addedAt: '2026-11-25T00:00:00.000Z',
    });
    const before = `${JSON.stringify({
      version: 1,
      wikis: [record('forgejo', 5, 7), record('github', 9, 70)],
      owners: { team: 7 },
      hostOwners: { github: { team: 70 } },
    })}\n`;
    writeFileSync(file, before);
    const table = openWikiTable(file);
    expect(table.pinsOn('forgejo').pinned()).toEqual({ team: 7 });
    expect(table.pinsOn('github').pinned()).toEqual({ team: 70 });
    expect(table.byId('forgejo', 5)?.key).toBe('forgejo-5');
    expect(table.byId('github', 9)?.key).toBe('github-9');
    table.pinsOn('forgejo').pin('team', 7);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each([
    ['github first, forgejo further', 'github', 'forgejo'],
    ['forgejo first, github further', 'forgejo', 'github'],
  ] as const)(
    "gives main's first-host pins to the first host when ids repeat (%s, O1)",
    (_name, first, further) => {
      const dir = mkdtempSync(join(tmpdir(), 'gq-table-'));
      dirs.push(dir);
      const file = join(dir, 'wikis.json');
      const record = (host: 'github' | 'forgejo', id: number, owner: string, ownerId: number) => ({
        host,
        id,
        owner,
        ownerId,
        name: 'wiki',
        key: `${host}-${id}`,
        state: 'on',
        formerNames: [],
        addedBy: 'alice',
        addedAt: '2026-11-25T00:00:00.000Z',
      });
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          wikis: [record(further, 2, 'team', 7), record(first, 1, 'team', 7)],
          owners: { team: 7 },
          hostOwners: { [further]: { team: 7 } },
        }),
      );
      const table = openWikiTable(file);
      expect(table.pinsOn(first).pinned()).toEqual({ team: 7 });
      expect(table.pinsOn(further).pinned()).toEqual({ team: 7 });
    },
  );

  it('keeps pins made while the first host had no wiki, and never hands them to another reading after a wiki is added again (O1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gq-table-'));
    dirs.push(dir);
    const file = join(dir, 'wikis.json');
    writeFileSync(
      file,
      JSON.stringify({ version: 1, wikis: [], owners: { team: 7 }, hostOwners: {} }),
    );
    const table = openWikiTable(file);
    table.pinsOn('github').pin('docs', 8);
    table.add({ host: 'github', id: 3, owner: 'team', ownerId: 7, name: 'wiki' }, 'a', 0, 'github');
    const again = openWikiTable(file);
    expect(again.pinsOn('github').pinned()).toEqual({ docs: 8 });
    expect(again.pinsOn('forgejo').pinned()).toEqual({});
  });
});
