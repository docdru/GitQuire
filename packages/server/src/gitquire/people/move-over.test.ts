import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveChatKeySecret, derivePeopleKeySecret } from '../chat/key-secret.ts';
import { createChatKeyStore } from '../chat/key-store.ts';
import type { Mention } from '../mentions.ts';
import { personKeyStore } from './chat-data.ts';
import { readMailRecord, recordAccountAddress } from './mail.ts';
import { createPeopleMailer, knownWikis, mailedIds } from './mailer.ts';
import { copyPeopleForWiki, movedWikis, movePeopleData, SINGLE_WIKI_KEY } from './move-over.ts';
import { personSettings } from './settings.ts';
import { createPeopleStore, SETTINGS_FILE } from './store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SECRET = 'S'.repeat(40);
const KEY_A = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function local(dir: string, ...parts: string[]): string {
  return join(dir, '.gitquire', 'local', 'gitquire', ...parts);
}

function write(path: string, text: string, at?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  if (at !== undefined) utimesSync(path, at / 1000, at / 1000);
}

function wiki(
  root: string,
  key: string,
  users: Record<string, unknown>,
  extra: (dir: string) => void = () => {},
) {
  const dir = join(root, 'wikis', key);
  write(local(dir, 'mentions.json'), JSON.stringify({ version: 1, users }));
  extra(dir);
  return {
    dir,
    wikiKey: key,
    idPrefix: 'github-',
    keySecrets: [deriveChatKeySecret(SECRET, key), SECRET],
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gq-move-people-'));
  dirs.push(root);
  const store = createPeopleStore(join(root, 'server', 'people'));
  const keys = personKeyStore(store, derivePeopleKeySecret(SECRET));
  return { root, store, keys };
}

describe('moving per-wiki data to the front door', () => {
  it('carries a confirmed address over, switched on, the most recently confirmed one winning (P4, P7)', () => {
    const { root, store, keys } = setup();
    const marked: string[] = [];
    const a = wiki(root, 'github-1', {
      11: {
        read: [],
        login: 'anna',
        email: 'anna@old.example',
        since: '2026-10-01T00:00:00.000Z',
        lastSeen: '2026-11-01T00:00:00.000Z',
        mailed: ['t1:c1'],
        pending: {
          email: 'x@y.example',
          codeHash: 'h',
          sentAt: '2026-11-20T00:00:00Z',
          attempts: 0,
        },
      },
      12: { read: ['t1:c2'], login: 'bert' },
    });
    const b = wiki(root, 'github-2', {
      11: {
        read: [],
        login: 'anna',
        email: 'anna@new.example',
        since: '2026-11-10T00:00:00.000Z',
        mailed: ['t9:c9'],
      },
    });
    const c = wiki(root, 'github-3', { 11: { read: [], login: 'anna' } });
    const report = movePeopleData([a, b, c], {
      store,
      keys,
      markExisting: (person, login, wikiKey) => marked.push(`${person}:${login}:${wikiKey}`),
    });
    expect(report.wikis).toEqual(['github-1', 'github-2', 'github-3']);
    const anna = readMailRecord(store, 'github-11');
    expect(anna).toMatchObject({
      login: 'anna',
      use: 'other',
      other: { address: 'anna@new.example' },
      since: '2026-10-01T00:00:00.000Z',
      lastSeen: '2026-11-01T00:00:00.000Z',
    });
    expect(anna.pending).toBeUndefined();
    expect([...mailedIds(store, 'github-11', 'github-1')]).toEqual(['t1:c1']);
    expect([...mailedIds(store, 'github-11', 'github-2')]).toEqual(['t9:c9']);
    expect(marked).toEqual(['github-11:anna:github-2', 'github-11:anna:github-3']);
    expect(readMailRecord(store, 'github-12').use).toBeUndefined();
  });

  it('still marks what was there when a first move stopped partway (P4)', () => {
    const { root, store, keys } = setup();
    const a = wiki(root, 'github-1', {
      11: { read: [], login: 'anna', email: 'anna@old.example', since: '2026-10-01T00:00:00.000Z' },
    });
    const c = wiki(root, 'github-3', { 11: { read: [], login: 'anna' } });
    expect(() =>
      movePeopleData([a, c], {
        store,
        keys,
        markExisting: () => {
          throw new Error('stopped');
        },
      }),
    ).toThrow('stopped');
    expect(readMailRecord(store, 'github-11').use).toBe('other');
    const marked: string[] = [];
    const report = movePeopleData([a, c], {
      store,
      keys,
      markExisting: (person, login, wikiKey) => marked.push(`${person}:${login}:${wikiKey}`),
    });
    expect(report.wikis).toEqual(['github-1', 'github-3']);
    expect(marked).toEqual(['github-11:anna:github-3']);
    expect([...knownWikis(store, 'github-11')].sort()).toEqual(['github-1']);
  });

  it('stores an address that equals the account address as the account address', () => {
    const { root, store, keys } = setup();
    recordAccountAddress(
      store,
      'github-11',
      'anna',
      { state: 'found', address: 'Anna@Example.org' },
      new Date(),
    );
    const a = wiki(root, 'github-1', {
      11: { read: [], login: 'anna', email: 'anna@example.org', since: '2026-10-01T00:00:00.000Z' },
    });
    movePeopleData([a], { store, keys });
    expect(readMailRecord(store, 'github-11')).toMatchObject({ use: 'account' });
    expect(readMailRecord(store, 'github-11').other).toBeUndefined();
  });

  it('takes the most recent personal settings, the agent mode and the newest key per provider', () => {
    const { root, store, keys } = setup();
    const a = wiki(root, 'github-1', {}, (dir) => {
      write(
        local(dir, 'users', '11.yml'),
        'editor:\n  spellcheck: false\n',
        Date.parse('2026-10-01T00:00:00Z'),
      );
      write(
        local(dir, 'drafts.json'),
        JSON.stringify({ version: 1, drafts: [], agentModes: { 11: 'draft' } }),
      );
      createChatKeyStore(dir, deriveChatKeySecret(SECRET, 'github-1')).set(
        11,
        'claude',
        KEY_A,
        new Date('2026-10-01T00:00:00Z'),
      );
    });
    const b = wiki(root, 'github-2', {}, (dir) => {
      write(
        local(dir, 'users', '11.yml'),
        'editor:\n  spellcheck: true\n',
        Date.parse('2026-11-01T00:00:00Z'),
      );
      createChatKeyStore(dir, SECRET).set(11, 'claude', KEY_B, new Date('2026-11-01T00:00:00Z'));
    });
    const report = movePeopleData([a, b], { store, keys });
    expect(report.keys).toBe(1);
    expect(store.readText('github-11', SETTINGS_FILE)).toBe('editor:\n  spellcheck: true\n');
    expect(personSettings(store).agentMode('github-11')).toBe('draft');
    expect(keys.get('github-11', 'claude')).toBe(KEY_B);
    expect(readFileSync(join(store.root, 'github-11', 'ai-keys.json'), 'utf8')).not.toContain(
      KEY_B,
    );
  });

  it('leaves the old files as they were, so the previous version still finds them', () => {
    const { root, store, keys } = setup();
    const a = wiki(root, 'github-1', {
      11: { read: [], login: 'anna', email: 'anna@example.org', since: '2026-10-01T00:00:00.000Z' },
    });
    const before = readFileSync(local(a.dir, 'mentions.json'), 'utf8');
    movePeopleData([a], { store, keys });
    expect(readFileSync(local(a.dir, 'mentions.json'), 'utf8')).toBe(before);
  });

  it('moves each wiki once, and never matches accounts on two hosts (P5)', () => {
    const { root, store, keys } = setup();
    const a = wiki(root, 'github-1', {
      11: { read: [], login: 'anna', email: 'anna@example.org', since: '2026-10-01T00:00:00.000Z' },
    });
    movePeopleData([a], { store, keys });
    expect(movedWikis(store)).toEqual(new Set(['github-1']));
    expect(movePeopleData([a], { store, keys }).wikis).toEqual([]);
    const f = {
      ...wiki(root, 'forgejo-1', {
        11: {
          read: [],
          login: 'anna',
          email: 'other@example.org',
          since: '2026-11-01T00:00:00.000Z',
        },
      }),
      idPrefix: 'forgejo-',
    };
    movePeopleData([f], { store, keys });
    expect(readMailRecord(store, 'github-11').other?.address).toBe('anna@example.org');
    expect(readMailRecord(store, 'forgejo-11').other?.address).toBe('other@example.org');
  });

  it('says how many saved keys could not be opened', () => {
    const { root, store, keys } = setup();
    const a = wiki(root, 'github-1', {}, (dir) => {
      createChatKeyStore(dir, 'W'.repeat(40)).set(11, 'claude', KEY_A, new Date());
    });
    expect(movePeopleData([a], { store, keys }).unreadableKeys).toBe(1);
  });
});

function mention(id: string, at: string): Mention {
  return {
    id,
    path: 'p.md',
    docName: 'p',
    threadId: 't',
    commentId: id,
    author: { id: 'github-99', login: 'carl' },
    at,
    body: '@anna',
    quote: 'q',
    resolved: false,
    logins: ['anna'],
  };
}

describe('moving over and the first mail round afterwards (P4)', () => {
  it('mails nothing that was there before, in the wikis with and without an address', async () => {
    const { root, store, keys } = setup();
    const mentions: Record<string, Mention[]> = {
      'github-1': [mention('a-old', '2026-03-01T00:00:00.000Z')],
      'github-2': [
        mention('b-between', '2026-05-01T00:00:00.000Z'),
        mention('b-later', '2026-11-20T00:00:00.000Z'),
      ],
      'github-3': [mention('c-any', '2026-06-01T00:00:00.000Z')],
    };
    const sent: string[] = [];
    const mailer = createPeopleMailer({
      store,
      config: {
        host: 'smtp.example.org',
        port: 587,
        implicitTls: false,
        startTls: true,
        user: undefined,
        password: undefined,
        from: 'w@example.org',
        externalUrl: undefined,
        allowedDomains: undefined,
      },
      send: async (_c, message) => {
        sent.push(message.text);
      },
      wikis: () =>
        Object.keys(mentions).map((key) => ({
          key,
          idPrefix: 'github-',
          name: key,
          url: undefined,
          mentions: () => mentions[key] ?? [],
          readIds: () => new Set<string>(),
          canOpen: async () => 'open' as const,
        })),
      log: { warn: () => {} },
      now: () => Date.parse('2026-11-25T00:00:00Z'),
    });
    const a = wiki(root, 'github-1', {
      11: {
        read: [],
        login: 'anna',
        email: 'anna@example.org',
        since: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-11-24T00:00:00.000Z',
        mailed: ['a-old'],
      },
    });
    const b = wiki(root, 'github-2', {
      11: {
        read: [],
        login: 'anna',
        email: 'anna@example.org',
        since: '2026-10-01T00:00:00.000Z',
        mailed: ['b-later'],
      },
    });
    movePeopleData([a, b], {
      store,
      keys,
      markExisting: (person, login, wikiKey, before) =>
        mailer.markExisting(person, login, wikiKey, before),
      wikiKeys: () => ['github-1', 'github-2', 'github-3'],
    });
    const first = await mailer.round();
    expect([first, ...sent]).toEqual([0]);
    mentions['github-2']?.push(mention('b-new', '2026-11-24T12:00:00.000Z'));
    expect(await mailer.round()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('skips a damaged "since" and keeps the good address', () => {
    const { root, store, keys } = setup();
    const a = wiki(root, 'github-1', {
      11: { read: [], login: 'anna', email: 'bad@example.org', since: 'garbage' },
    });
    const b = wiki(root, 'github-2', {
      11: { read: [], login: 'anna', email: 'good@example.org', since: '2026-10-01T00:00:00.000Z' },
    });
    movePeopleData([a, b], { store, keys });
    expect(readMailRecord(store, 'github-11')).toMatchObject({
      other: { address: 'good@example.org' },
      since: '2026-10-01T00:00:00.000Z',
    });
  });
});

describe('the way back for one wiki (unadopt) and in again (adopt)', () => {
  it('copies one wiki’s data to the single wiki and back, keeping "mailed" and keys', () => {
    const { root, store, keys } = setup();
    const a = wiki(root, 'github-1', {
      11: {
        read: [],
        login: 'anna',
        email: 'anna@example.org',
        since: '2026-10-01T00:00:00.000Z',
        mailed: ['t1:c1'],
      },
    });
    movePeopleData([a], { store, keys });
    keys.set('github-11', 'claude', KEY_A);
    const single = createPeopleStore(join(root, 'single', 'people'));
    copyPeopleForWiki(store, single, 'github-1', SINGLE_WIKI_KEY);
    expect([...mailedIds(single, 'github-11', SINGLE_WIKI_KEY)]).toEqual(['t1:c1']);
    expect(personKeyStore(single, derivePeopleKeySecret(SECRET)).get('github-11', 'claude')).toBe(
      KEY_A,
    );
    const again = createPeopleStore(join(root, 'again', 'people'));
    copyPeopleForWiki(single, again, SINGLE_WIKI_KEY, 'github-1');
    expect([...mailedIds(again, 'github-11', 'github-1')]).toEqual(['t1:c1']);
    expect(readMailRecord(again, 'github-11').other?.address).toBe('anna@example.org');
  });

  it('writes nothing when there is nothing to move', () => {
    const { root, store, keys } = setup();
    const empty = {
      dir: join(root, 'wikis', 'github-9'),
      wikiKey: 'github-9',
      idPrefix: 'github-',
      keySecrets: [],
    };
    movePeopleData([empty], { store, keys });
    expect(existsSync(store.root)).toBe(false);
  });
});
