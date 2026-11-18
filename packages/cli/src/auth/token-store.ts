import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GQ_USER_HOME_AUTH_FILE, okUserHomeDisplayPath } from '@gitquire/core/constants/ok-dir';
import { okUserHomeDir } from '@gitquire/core/constants/ok-user-home';
import { atomicWriteFileSync } from '@gitquire/core/util/atomic-yaml-write';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

interface TokenEntry {
  login: string;
  token: string;
  gitProtocol?: string;
  name?: string;
  email?: string;
}

export interface TokenStore {
  readonly backend: 'file';
  get(host: string): Promise<TokenEntry | null>;
  set(
    host: string,
    login: string,
    token: string,
    extra?: Pick<TokenEntry, 'gitProtocol' | 'name' | 'email'>,
  ): Promise<void>;
  clear(host: string): Promise<void>;
}

export function authFileDisplayPath(): string {
  return okUserHomeDisplayPath(GQ_USER_HOME_AUTH_FILE);
}

export class FileBackend implements TokenStore {
  readonly backend = 'file' as const;
  private readonly authFile: string;

  constructor(authFile?: string) {
    this.authFile = authFile ?? join(okUserHomeDir(), GQ_USER_HOME_AUTH_FILE);
  }

  private read(): Record<string, TokenEntry> {
    if (!existsSync(this.authFile)) return {};
    try {
      const raw = readFileSync(this.authFile, 'utf-8');
      return (yamlParse(raw) ?? {}) as Record<string, TokenEntry>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      process.stderr.write(
        `[auth] Failed to parse ${this.authFile}: ${msg}. Starting with empty credentials.\n`,
      );
      return {};
    }
  }

  private write(data: Record<string, TokenEntry>): void {
    const dir = dirname(this.authFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.authFile, yamlStringify(data), { mode: 0o600 });
  }

  async get(host: string): Promise<TokenEntry | null> {
    return this.read()[host] ?? null;
  }

  async set(
    host: string,
    login: string,
    token: string,
    extra?: Pick<TokenEntry, 'gitProtocol' | 'name' | 'email'>,
  ): Promise<void> {
    const data = this.read();
    data[host] = { login, token, ...extra };
    this.write(data);
  }

  async clear(host: string): Promise<void> {
    const data = this.read();
    delete data[host];
    this.write(data);
  }
}

export async function createTokenStore(authFile?: string): Promise<TokenStore> {
  return new FileBackend(authFile);
}

export function makeLazyProbeTokenStore(authFile?: string): {
  get: (host: string) => Promise<{ token?: string; login?: string } | null>;
} {
  const store = new FileBackend(authFile);
  return {
    async get(host: string) {
      const entry = await store.get(host);
      return entry === null ? null : { token: entry.token, login: entry.login };
    },
  };
}

export function makeLazyTokenStore(authFile?: string): TokenStore {
  return new FileBackend(authFile);
}

export async function clearStoredToken(host: string, authFile?: string): Promise<boolean> {
  const file = new FileBackend(authFile);
  if ((await file.get(host)) == null) return false;
  await file.clear(host);
  return true;
}
