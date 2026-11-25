import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveChatKeySecret, derivePeopleKeySecret } from '../chat/key-secret.ts';
import { createChatKeyStore } from '../chat/key-store.ts';
import { personKeyStore } from './chat-data.ts';
import { readMailRecord, recordAccountAddress } from './mail.ts';
import { mailedIds } from './mailer.ts';
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
    expect(marked).toEqual(['github-11:anna:github-3']);
    expect(readMailRecord(store, 'github-12').use).toBeUndefined();
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
});
