import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ChatRecord,
  chatsDir,
  createChatHistoryStore,
  newChatId,
  titleFrom,
} from './history.ts';
import { chatKeysDir, createChatKeyStore, keyHint, normalizeApiKey } from './key-store.ts';

const SECRET = 'x'.repeat(40);
const dirs: string[] = [];

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-chat-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function chat(id: string, updatedAt: string): ChatRecord {
  return {
    id,
    title: 'T',
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    createdAt: updatedAt,
    updatedAt,
    messages: [{ role: 'user', text: 'hi', at: updatedAt }],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe('API key store', () => {
  it('keeps keys encrypted, per person and per provider', () => {
    const dir = project();
    const store = createChatKeyStore(dir, SECRET);
    store.set(7, 'claude', 'sk-ant-secret-1234');
    store.set(7, 'mistral', 'mistral-secret-9876');
    store.set(8, 'claude', 'sk-ant-other-5555');

    expect(store.get(7, 'claude')).toBe('sk-ant-secret-1234');
    expect(store.get(7, 'mistral')).toBe('mistral-secret-9876');
    expect(store.get(8, 'mistral')).toBeUndefined();
    const raw = readFileSync(join(chatKeysDir(dir), '7.json'), 'utf8');
    expect(raw).not.toContain('sk-ant-secret');
    expect(raw).not.toContain('mistral-secret');
    expect(store.info(7).claude).toMatchObject({ configured: true, hint: '…1234' });
    expect(store.info(8).mistral).toMatchObject({ configured: false, hint: null });
  });

  it('cannot open a key that was copied to another person', () => {
    const dir = project();
    const store = createChatKeyStore(dir, SECRET);
    store.set(7, 'claude', 'sk-ant-secret-1234');
    writeFileSync(join(chatKeysDir(dir), '9.json'), readFileSync(join(chatKeysDir(dir), '7.json')));
    expect(store.get(9, 'claude')).toBeUndefined();
    expect(store.info(9).claude).toMatchObject({ configured: false, unreadable: true });
  });

  it('reports keys saved under another session secret as unreadable', () => {
    const dir = project();
    createChatKeyStore(dir, SECRET).set(7, 'claude', 'sk-ant-secret-1234');
    const rotated = createChatKeyStore(dir, 'y'.repeat(40));
    expect(rotated.get(7, 'claude')).toBeUndefined();
    expect(rotated.info(7).claude.unreadable).toBe(true);
  });

  it('removes the file when the last key is removed', () => {
    const dir = project();
    const store = createChatKeyStore(dir, SECRET);
    store.set(7, 'claude', 'sk-ant-secret-1234');
    store.remove(7, 'claude');
    expect(existsSync(join(chatKeysDir(dir), '7.json'))).toBe(false);
  });

  it('checks pasted keys', () => {
    expect(normalizeApiKey('  sk-abc  ')).toBe('sk-abc');
    expect(() => normalizeApiKey('')).toThrow('empty');
    expect(() => normalizeApiKey('sk abc')).toThrow('no spaces');
    expect(() => normalizeApiKey(42)).toThrow();
    expect(keyHint('short')).toBe('…');
  });

  it('refuses a short secret', () => {
    expect(() => createChatKeyStore(project(), 'short')).toThrow('32+');
  });
});

describe('chat history store', () => {
  it('lists a person’s chats, newest first, and nobody else’s', () => {
    const dir = project();
    const store = createChatHistoryStore(dir);
    const a = newChatId();
    const b = newChatId();
    store.save(7, chat(a, '2026-11-01T10:00:00.000Z'));
    store.save(7, chat(b, '2026-11-02T10:00:00.000Z'));
    store.save(8, chat(newChatId(), '2026-11-03T10:00:00.000Z'));

    expect(store.list(7).map((entry) => entry.id)).toEqual([b, a]);
    expect(store.get(8, a)).toBeUndefined();
    expect(store.remove(7, a)).toBe(true);
    expect(store.list(7).map((entry) => entry.id)).toEqual([b]);
  });

  it('deletes chats not touched for 90 days and leftovers of interrupted writes', () => {
    const dir = project();
    const store = createChatHistoryStore(dir);
    const old = newChatId();
    const recent = newChatId();
    store.save(7, chat(old, '2026-08-01T00:00:00.000Z'));
    store.save(7, chat(recent, '2026-08-20T00:00:00.000Z'));
    const broken = join(chatsDir(dir), '7', 'broken.json');
    writeFileSync(broken, '{');
    const past = new Date('2026-01-01T00:00:00Z');
    utimesSync(broken, past, past);
    writeFileSync(join(chatsDir(dir), '7', 'x.json.1.tmp'), '');

    const removed = store.purgeExpired(new Date('2026-11-14T00:00:00.000Z'));

    expect(removed).toBe(2);
    expect(store.list(7).map((entry) => entry.id)).toEqual([recent]);
    expect(existsSync(join(chatsDir(dir), '7', 'x.json.1.tmp'))).toBe(false);
  });

  it('rejects ids that could leave the folder', () => {
    const store = createChatHistoryStore(project());
    expect(store.get(7, '../../etc/passwd')).toBeUndefined();
    expect(store.remove(7, '../x')).toBe(false);
    expect(() => store.save(7, chat('../escape', '2026-11-01T00:00:00Z'))).toThrow();
  });

  it('titles chats from the first message', () => {
    expect(titleFrom('  hello\n world ')).toBe('hello world');
    expect(titleFrom('')).toBe('New chat');
    expect(titleFrom('a'.repeat(80))).toHaveLength(58);
  });
});
