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
  return join(projectDir, '.ok', 'local', 'gitquire', 'ai-keys');
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

export function createChatKeyStore(projectDir: string, secret: string): ChatKeyStore {
  if (secret.length < 32) throw new Error('The AI chat needs a session secret of 32+ characters.');
  const masterKey = Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), KEY_INFO, 32),
  );

  function readFile(userId: number): KeyFile {
    const file = fileFor(projectDir, userId);
    if (!existsSync(file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as KeyFile) : {};
    } catch {
      return {};
    }
  }

  function writeFile(userId: number, value: KeyFile): void {
    const file = fileFor(projectDir, userId);
    if (Object.keys(value).length === 0) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  }

  function aad(userId: number, provider: ChatProvider): Buffer {
    return Buffer.from(`${userId}:${provider}`, 'utf8');
  }

  function open(userId: number, provider: ChatProvider, sealed: SealedKey): string | undefined {
    try {
      const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(aad(userId, provider));
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
    info(userId) {
      const file = readFile(userId);
      const out = {} as Record<ChatProvider, StoredKeyInfo>;
      for (const provider of CHAT_PROVIDERS) {
        const sealed = file[provider];
        if (sealed === undefined) {
          out[provider] = { configured: false, hint: null, savedAt: null };
          continue;
        }
        const readable = open(userId, provider, sealed) !== undefined;
        out[provider] = {
          configured: readable,
          hint: sealed.hint,
          savedAt: sealed.savedAt,
          ...(readable ? {} : { unreadable: true }),
        };
      }
      return out;
    },
    get(userId, provider) {
      const sealed = readFile(userId)[provider];
      return sealed === undefined ? undefined : open(userId, provider, sealed);
    },
    set(userId, provider, key, now = new Date()) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      cipher.setAAD(aad(userId, provider));
      const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
      const sealed: SealedKey = {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
        hint: keyHint(key),
        savedAt: now.toISOString(),
      };
      writeFile(userId, { ...readFile(userId), [provider]: sealed });
      return { configured: true, hint: sealed.hint, savedAt: sealed.savedAt };
    },
    remove(userId, provider) {
      const file = readFile(userId);
      delete file[provider];
      writeFile(userId, file);
    },
  };
}
