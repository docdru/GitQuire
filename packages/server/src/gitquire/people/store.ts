import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const PERSON_ID_RE = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?-[1-9][0-9]{0,15}$/;

export type PersonFile = 'mail.json' | 'mailed.json' | 'prefs.json' | 'ai-keys.json' | 'usage.json';

export const SETTINGS_FILE = 'settings.yml';

export function isPersonId(value: unknown): value is string {
  return typeof value === 'string' && PERSON_ID_RE.test(value);
}

export function personId(idPrefix: string, accountId: number): string {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(`invalid account id: ${accountId}`);
  }
  const id = `${idPrefix}${accountId}`;
  if (!isPersonId(id)) throw new Error(`invalid person id: ${id}`);
  return id;
}

export function frontDoorPeopleRoot(dataDir: string): string {
  return join(dataDir, 'server', 'people');
}

export function singleWikiPeopleRoot(projectDir: string): string {
  return join(projectDir, '.gitquire', 'local', 'gitquire', 'people');
}

export interface PeopleStore {
  readonly root: string;
  readJson: <T>(person: string, file: PersonFile, parse: (raw: unknown) => T) => T;
  updateJson: <T>(
    person: string,
    file: PersonFile,
    parse: (raw: unknown) => T,
    change: (current: T) => T,
  ) => T;
  readText: (person: string, file: typeof SETTINGS_FILE) => string;
  writeText: (person: string, file: typeof SETTINGS_FILE, text: string) => void;
  changedAt: (person: string, file: PersonFile | typeof SETTINGS_FILE) => number | undefined;
  remove: (person: string, file: PersonFile | typeof SETTINGS_FILE) => void;
  people: () => string[];
}

function syncFolder(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAtomic(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  syncFolder(dirname(file));
}

export function createPeopleStore(root: string): PeopleStore {
  const cache = new Map<string, unknown>();

  function folder(person: string): string {
    if (!isPersonId(person)) throw new Error(`invalid person id: ${person}`);
    return join(root, person);
  }

  function ensureFolder(person: string): string {
    const dir = folder(person);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  function rawJson(path: string): unknown {
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  function readJson<T>(person: string, file: PersonFile, parse: (raw: unknown) => T): T {
    const path = join(folder(person), file);
    if (!cache.has(path)) cache.set(path, rawJson(path));
    return parse(structuredClone(cache.get(path)));
  }

  return {
    root,
    readJson,
    updateJson: (person, file, parse, change) => {
      const next = change(readJson(person, file, parse));
      const path = join(ensureFolder(person), file);
      writeAtomic(path, `${JSON.stringify(next)}\n`);
      cache.set(path, structuredClone(next));
      return next;
    },
    readText: (person, file) => {
      const path = join(folder(person), file);
      try {
        return existsSync(path) ? readFileSync(path, 'utf8') : '';
      } catch {
        return '';
      }
    },
    writeText: (person, file, text) => {
      writeAtomic(join(ensureFolder(person), file), text);
    },
    changedAt: (person, file) => {
      try {
        return statSync(join(folder(person), file)).mtimeMs;
      } catch {
        return undefined;
      }
    },
    remove: (person, file) => {
      const path = join(folder(person), file);
      cache.delete(path);
      rmSync(path, { force: true });
    },
    people: () => {
      if (!existsSync(root)) return [];
      return readdirSync(root).filter(isPersonId).sort();
    },
  };
}
