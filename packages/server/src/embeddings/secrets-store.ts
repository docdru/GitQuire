import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_EMBEDDINGS_BASE_URL, GQ_USER_HOME_SECRETS_FILE } from '@gitquire/core';
import { okUserHomeDir } from '@gitquire/core/server';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  tracedMkdirSync,
  tracedRenameSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from '../fs-traced.ts';
import { sleepSyncMs } from '../sleep-sync.ts';
import { EmbeddingsSecretStoreError } from './credential-errors.ts';
import { normalizeProviderId } from './embedder.ts';

const DEFAULT_ENDPOINT_ID = normalizeProviderId(DEFAULT_EMBEDDINGS_BASE_URL);

const SECRETS_KEY_FIELD = 'OPENAI_API_KEY';

const LEGACY_KEY_FIELD = 'embeddings';

const PROJECTS_FIELD = 'embeddings_projects';
type ProjectsMap = Record<string, Record<string, string>>;

const EMBEDDINGS_STORE_TIMEOUT_MS = 2000;
const EMBEDDINGS_LOCK_WAIT_MS = 1500;

export type EmbeddingsKeySource = 'project' | 'file' | 'env' | null;

export interface ResolvedEmbeddingsKey {
  key: string | null;
  source: EmbeddingsKeySource;
}

export function canonicalProjectKey(projectDir: string): string {
  try {
    return realpathSync.native(projectDir);
  } catch {
    return resolve(projectDir);
  }
}

export function secretsFilePath(homedirOverride?: string): string {
  return join(okUserHomeDir(homedirOverride ?? homedir()), GQ_USER_HOME_SECRETS_FILE);
}

export interface EmbeddingsKeyPresence {
  present: boolean;
  hint: string | null;
  source: EmbeddingsKeySource;
}

export interface EmbeddingsProjectListing {
  projectKey: string;
  endpoints: Array<{ endpoint: string; hint: string | null }>;
}

export interface EmbeddingsKeyReader {
  resolveForProject(projectDir: string, baseUrl: string): Promise<ResolvedEmbeddingsKey>;
  describeForProject(projectDir: string, baseUrl: string): Promise<EmbeddingsKeyPresence>;
  getLegacyKey(): Promise<string | null>;
}

export interface EmbeddingsSecretStore extends EmbeddingsKeyReader {
  readonly backend: 'file';
  setForProject(projectDir: string, baseUrl: string, key: string): Promise<void>;
  clearForProject(projectDir: string, baseUrl: string): Promise<boolean>;
  clearAllForProject(projectDir: string): Promise<boolean>;
  listProjects(): Promise<EmbeddingsProjectListing[]>;
  clearAll(): Promise<{ touched: Array<'file'> }>;
}

function keyHint(key: string | null): string | null {
  return key && key.length >= 8 ? key.slice(-4) : null;
}

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10_000;

export class FileEmbeddingsBackend implements EmbeddingsSecretStore {
  readonly backend = 'file' as const;
  private readonly secretsFile: string;

  constructor(secretsFile?: string) {
    this.secretsFile = secretsFile ?? secretsFilePath();
  }

  private withLock<T>(fn: () => T): T {
    const lockPath = `${this.secretsFile}.lock`;
    const dir = dirname(this.secretsFile);
    if (!existsSync(dir)) tracedMkdirSync(dir, { recursive: true, mode: 0o700 });
    const start = Date.now();
    let held = false;
    while (!held) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        held = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          const msg = err instanceof Error ? err.message : 'unknown error';
          process.stderr.write(
            `[embeddings] could not acquire the secrets write-lock (${msg}); ` +
              `proceeding without cross-process serialization.\n`,
          );
          break;
        }
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - start > LOCK_TIMEOUT_MS) break;
        sleepSyncMs(15);
      }
    }
    try {
      return fn();
    } finally {
      if (held) {
        try {
          unlinkSync(lockPath);
        } catch {}
      }
    }
  }

  private tightenPermsIfLoose(strict = false): void {
    let mode: number;
    try {
      mode = statSync(this.secretsFile).mode & 0o777;
    } catch (error) {
      if (strict) throw new EmbeddingsSecretStoreError('file_access', 'file_read', error);
      return;
    }
    if (strict ? mode === 0o600 : (mode & 0o077) === 0) return;
    try {
      chmodSync(this.secretsFile, 0o600);
      process.stderr.write(
        `[embeddings] ${this.secretsFile} was readable beyond your user account ` +
          `(mode ${mode.toString(8)}); tightened to 600. It stores an API key.\n`,
      );
    } catch (e) {
      if (strict) throw new EmbeddingsSecretStoreError('file_access', 'file_read', e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      process.stderr.write(
        `[embeddings] ${this.secretsFile} is readable beyond your user account ` +
          `(mode ${mode.toString(8)}) and could not be tightened (${msg}); your API key ` +
          `remains exposed — run: chmod 600 ${this.secretsFile}\n`,
      );
    }
  }

  read(strict = false): Record<string, unknown> {
    if (!existsSync(this.secretsFile)) return {};
    this.tightenPermsIfLoose(strict);
    try {
      const parsed: unknown = yamlParse(readFileSync(this.secretsFile, 'utf-8')) ?? {};
      if (strict && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
        throw new Error('Invalid embeddings secrets');
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      if (strict) throw new EmbeddingsSecretStoreError('file_access', 'file_read', e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      process.stderr.write(
        `[embeddings] Failed to parse ${this.secretsFile}: ${msg}. Starting with empty secrets.\n`,
      );
      return {};
    }
  }

  private write(data: Record<string, unknown>): void {
    const dir = dirname(this.secretsFile);
    if (!existsSync(dir)) tracedMkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.secretsFile}.tmp`;
    tracedWriteFileSync(tmp, yamlStringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    tracedRenameSync(tmp, this.secretsFile);
    chmodSync(this.secretsFile, 0o600);
  }

  writeOrUnlink(data: Record<string, unknown>, strict = false): void {
    if (Object.keys(data).length === 0) {
      try {
        tracedUnlinkSync(this.secretsFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (strict) throw err;
          const msg = err instanceof Error ? err.message : 'unknown error';
          process.stderr.write(
            `[embeddings] could not remove ${this.secretsFile} (${msg}); a cleared key may ` +
              `remain on disk — delete the file manually if needed.\n`,
          );
        }
      }
      return;
    }
    this.write(data);
  }

  private readProjects(data: Record<string, unknown>): ProjectsMap {
    const raw = data[PROJECTS_FIELD];
    return raw && typeof raw === 'object' ? (raw as ProjectsMap) : {};
  }

  private legacyKey(data: Record<string, unknown>): string | null {
    const value = data[SECRETS_KEY_FIELD] ?? data[LEGACY_KEY_FIELD];
    return typeof value === 'string' && value !== '' ? value : null;
  }

  resolveForProject(projectDir: string, baseUrl: string): Promise<ResolvedEmbeddingsKey> {
    const data = this.read();
    const endpoint = normalizeProviderId(baseUrl);
    const slot = this.readProjects(data)[canonicalProjectKey(projectDir)]?.[endpoint];
    if (typeof slot === 'string' && slot !== '') {
      return Promise.resolve({ key: slot, source: 'project' });
    }
    if (endpoint === DEFAULT_ENDPOINT_ID) {
      const legacy = this.legacyKey(data);
      if (legacy) return Promise.resolve({ key: legacy, source: 'file' });
    }
    return Promise.resolve({ key: null, source: null });
  }

  describeForProject(projectDir: string, baseUrl: string): Promise<EmbeddingsKeyPresence> {
    return this.resolveForProject(projectDir, baseUrl).then(({ key, source }) => ({
      present: key !== null,
      hint: keyHint(key),
      source,
    }));
  }

  getLegacyKey(): Promise<string | null> {
    return Promise.resolve(this.legacyKey(this.read()));
  }

  setForProject(projectDir: string, baseUrl: string, key: string): Promise<void> {
    this.withLock(() => {
      const data = this.read();
      const projects = this.readProjects(data);
      const pkey = canonicalProjectKey(projectDir);
      projects[pkey] = { ...projects[pkey], [normalizeProviderId(baseUrl)]: key };
      data[PROJECTS_FIELD] = projects;
      this.write(data);
    });
    return Promise.resolve();
  }

  clearForProject(projectDir: string, baseUrl: string): Promise<boolean> {
    const existed = this.withLock(() => {
      const data = this.read();
      const projects = this.readProjects(data);
      const pkey = canonicalProjectKey(projectDir);
      const endpoint = normalizeProviderId(baseUrl);
      if (projects[pkey]?.[endpoint] === undefined) return false;
      delete projects[pkey][endpoint];
      if (Object.keys(projects[pkey]).length === 0) delete projects[pkey];
      if (Object.keys(projects).length === 0) delete data[PROJECTS_FIELD];
      else data[PROJECTS_FIELD] = projects;
      this.writeOrUnlink(data, true);
      return true;
    });
    return Promise.resolve(existed);
  }

  clearAllForProject(projectDir: string): Promise<boolean> {
    const existed = this.withLock(() => {
      const data = this.read();
      const projects = this.readProjects(data);
      const pkey = canonicalProjectKey(projectDir);
      if (projects[pkey] === undefined) return false;
      delete projects[pkey];
      if (Object.keys(projects).length === 0) delete data[PROJECTS_FIELD];
      else data[PROJECTS_FIELD] = projects;
      this.writeOrUnlink(data, true);
      return true;
    });
    return Promise.resolve(existed);
  }

  clearAll(): Promise<{ touched: Array<'file'> }> {
    const touched = this.withLock(() => {
      const data = this.read();
      const had =
        data[PROJECTS_FIELD] !== undefined ||
        data[SECRETS_KEY_FIELD] !== undefined ||
        data[LEGACY_KEY_FIELD] !== undefined;
      delete data[PROJECTS_FIELD];
      delete data[SECRETS_KEY_FIELD];
      delete data[LEGACY_KEY_FIELD];
      if (had) this.writeOrUnlink(data, true);
      return had;
    });
    return Promise.resolve(touched ? { touched: ['file'] as Array<'file'> } : { touched: [] });
  }

  listProjects(): Promise<EmbeddingsProjectListing[]> {
    const projects = this.readProjects(this.read());
    const listing = Object.entries(projects).map(([projectKey, endpoints]) => ({
      projectKey,
      endpoints: Object.entries(endpoints).map(([endpoint, key]) => ({
        endpoint,
        hint: keyHint(key),
      })),
    }));
    return Promise.resolve(listing);
  }
}

async function withEmbeddingsLock<T>(
  secretsFile: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const lockPath = `${secretsFile}.embeddings-lock.sqlite`;
  let db: DatabaseSync;
  try {
    tracedMkdirSync(dirname(secretsFile), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(lockPath);
  } catch (error) {
    throw new EmbeddingsSecretStoreError('file_access', 'lock', error);
  }
  try {
    try {
      chmodSync(lockPath, 0o600);
      db.exec('PRAGMA busy_timeout = 0');
    } catch (error) {
      throw new EmbeddingsSecretStoreError('file_access', 'lock', error);
    }
    const deadline = Date.now() + EMBEDDINGS_LOCK_WAIT_MS;
    for (;;) {
      signal?.throwIfAborted();
      try {
        db.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5)
          throw new EmbeddingsSecretStoreError('file_access', 'lock', error);
        if (Date.now() >= deadline)
          throw new EmbeddingsSecretStoreError('lock_timeout', 'lock', error);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
}

export function createEmbeddingsSecretStore(secretsFile?: string): EmbeddingsSecretStore {
  const path = secretsFile ?? secretsFilePath();
  async function run<T>(fn: (store: FileEmbeddingsBackend) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = withEmbeddingsLock(
      path,
      async () => {
        controller.signal.throwIfAborted();
        const file = new FileEmbeddingsBackend(path);
        try {
          file.read(true);
        } catch (error) {
          if (error instanceof EmbeddingsSecretStoreError) throw error;
          throw new EmbeddingsSecretStoreError('file_access', 'file_read', error);
        }
        try {
          return await fn(file);
        } catch (error) {
          if (error instanceof EmbeddingsSecretStoreError) throw error;
          throw new EmbeddingsSecretStoreError('file_access', 'file_write', error);
        }
      },
      controller.signal,
    );
    try {
      return await Promise.race([
        operation.catch((error: unknown) => {
          if (error instanceof EmbeddingsSecretStoreError) throw error;
          throw new EmbeddingsSecretStoreError('file_access', 'operation', error);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new EmbeddingsSecretStoreError('timeout', 'timeout'));
          }, EMBEDDINGS_STORE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    backend: 'file',
    resolveForProject: (project, endpoint) =>
      run((store) => store.resolveForProject(project, endpoint)),
    describeForProject: (project, endpoint) =>
      run((store) => store.describeForProject(project, endpoint)),
    getLegacyKey: () => run((store) => store.getLegacyKey()),
    setForProject: (project, endpoint, key) =>
      run((store) => store.setForProject(project, endpoint, key)),
    clearForProject: (project, endpoint) =>
      run((store) => store.clearForProject(project, endpoint)),
    clearAllForProject: (project) => run((store) => store.clearAllForProject(project)),
    listProjects: () => run((store) => store.listProjects()),
    clearAll: () => run((store) => store.clearAll()),
  };
}

export function makeLazyEmbeddingsKeyStore(secretsFile?: string): EmbeddingsKeyReader {
  return createEmbeddingsSecretStore(secretsFile);
}

export async function describeStoredEmbeddingsKey(
  projectDir: string,
  baseUrl: string,
  secretsFile?: string,
): Promise<EmbeddingsKeyPresence> {
  return createEmbeddingsSecretStore(secretsFile).describeForProject(projectDir, baseUrl);
}

export async function clearAllEmbeddingsKeys(
  secretsFile?: string,
): Promise<{ touched: Array<'file'> }> {
  return createEmbeddingsSecretStore(secretsFile).clearAll();
}
