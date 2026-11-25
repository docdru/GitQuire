import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CHAT_PROVIDERS, type ChatProvider } from './models.ts';

const KEY_INFO = 'gitquire-ai-chat-keys-v1';
const MAX_KEY_LENGTH = 512;
const KEY_PATTERN = /^[\x21-\x7e]+$/;

export interface StoredKeyInfo {
  configured: boolean;
  hint: string | null;
  savedAt: string | null;
  unreadable?: boolean;
}

interface SealedKey {
  iv: string;
  tag: string;
  data: string;
  hint: string;
  savedAt: string;
}

type KeyFile = Partial<Record<ChatProvider, SealedKey>>;

export class InvalidApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidApiKeyError';
  }
}

export function normalizeApiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidApiKeyError('Paste the API key as text.');
  const key = raw.trim();
  if (key === '') throw new InvalidApiKeyError('The API key is empty.');
  if (key.length > MAX_KEY_LENGTH) throw new InvalidApiKeyError('That is too long for an API key.');
  if (!KEY_PATTERN.test(key)) {
    throw new InvalidApiKeyError('An API key has no spaces or special characters.');
  }
  return key;
}

export function keyHint(key: string): string {
  return key.length <= 8 ? '…' : `…${key.slice(-4)}`;
}

export function chatKeysDir(projectDir: string): string {
  return join(projectDir, '.gitquire', 'local', 'gitquire', 'ai-keys');
}

function fileFor(projectDir: string, userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error(`invalid GitHub user id: ${userId}`);
  }
  return join(chatKeysDir(projectDir), `${userId}.json`);
}

export interface ChatKeyStore {
  info(userId: number): Record<ChatProvider, StoredKeyInfo>;
  get(userId: number, provider: ChatProvider): string | undefined;
  set(userId: number, provider: ChatProvider, key: string, now?: Date): StoredKeyInfo;
  remove(userId: number, provider: ChatProvider): void;
}

export interface SealedKeyStore {
  info(owner: string): Record<ChatProvider, StoredKeyInfo>;
  get(owner: string, provider: ChatProvider): string | undefined;
  set(owner: string, provider: ChatProvider, key: string, now?: Date): StoredKeyInfo;
  remove(owner: string, provider: ChatProvider): void;
  savedAt(owner: string, provider: ChatProvider): string | undefined;
}

export function createChatKeyStore(projectDir: string, secret: string): ChatKeyStore {
  const sealed = createSealedKeyStore((owner) => fileFor(projectDir, Number(owner)), secret);
  return {
    info: (userId) => sealed.info(String(userId)),
    get: (userId, provider) => sealed.get(String(userId), provider),
    set: (userId, provider, key, now) => sealed.set(String(userId), provider, key, now),
    remove: (userId, provider) => sealed.remove(String(userId), provider),
  };
}

export function createSealedKeyStore(
  fileOf: (owner: string) => string,
  secret: string,
): SealedKeyStore {
  if (secret.length < 32) throw new Error('The AI chat needs a session secret of 32+ characters.');
  const masterKey = Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), KEY_INFO, 32),
  );

  function readFile(owner: string): KeyFile {
    const file = fileOf(owner);
    if (!existsSync(file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as KeyFile) : {};
    } catch {
      return {};
    }
  }

  function writeFile(owner: string, value: KeyFile): void {
    const file = fileOf(owner);
    if (Object.keys(value).length === 0) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  }

  function aad(owner: string, provider: ChatProvider): Buffer {
    return Buffer.from(`${owner}:${provider}`, 'utf8');
  }

  function open(owner: string, provider: ChatProvider, sealed: SealedKey): string | undefined {
    try {
      const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(aad(owner, provider));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  return {
    info(owner) {
      const file = readFile(owner);
      const out = {} as Record<ChatProvider, StoredKeyInfo>;
      for (const provider of CHAT_PROVIDERS) {
        const sealed = file[provider];
        if (sealed === undefined) {
          out[provider] = { configured: false, hint: null, savedAt: null };
          continue;
        }
        const readable = open(owner, provider, sealed) !== undefined;
        out[provider] = {
          configured: readable,
          hint: sealed.hint,
          savedAt: sealed.savedAt,
          ...(readable ? {} : { unreadable: true }),
        };
      }
      return out;
    },
    get(owner, provider) {
      const sealed = readFile(owner)[provider];
      return sealed === undefined ? undefined : open(owner, provider, sealed);
    },
    savedAt(owner, provider) {
      return readFile(owner)[provider]?.savedAt;
    },
    set(owner, provider, key, now = new Date()) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      cipher.setAAD(aad(owner, provider));
      const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
      const sealed: SealedKey = {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
        hint: keyHint(key),
        savedAt: now.toISOString(),
      };
      writeFile(owner, { ...readFile(owner), [provider]: sealed });
      return { configured: true, hint: sealed.hint, savedAt: sealed.savedAt };
    },
    remove(owner, provider) {
      const file = readFile(owner);
      delete file[provider];
      writeFile(owner, file);
    },
  };
}
