import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionUser } from './access-gate.ts';
import type { RepoCollaborator } from './github-pulls.ts';

export const COLLABORATOR_CACHE_MS = 10 * 60 * 1000;
const REMEMBER_GAP_MS = 24 * 60 * 60 * 1000;
const MAX_PEOPLE = 500;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export interface Person {
  login: string;
  name?: string;
  avatarUrl?: string;
}

interface RememberedPerson {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
  lastSeen: string;
}

interface PeopleState {
  version: 1;
  people: Record<string, RememberedPerson>;
}

export interface PeopleDirectoryDeps {
  stateFile: string;
  allowedLogins?: readonly string[];
  collaborators?: () => Promise<RepoCollaborator[]>;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface PeopleDirectory {
  remember: (user: SessionUser) => void;
  list: () => Promise<Person[]>;
}

export function peopleStatePath(projectDir: string): string {
  return join(projectDir, '.ok', 'local', 'gitquire', 'people.json');
}

export function allowedLoginsFrom(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((login) => login.trim())
    .filter((login) => LOGIN_RE.test(login));
}

function readState(file: string): PeopleState {
  if (!existsSync(file)) return { version: 1, people: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PeopleState>;
    if (parsed?.version === 1 && typeof parsed.people === 'object' && parsed.people !== null) {
      return { version: 1, people: parsed.people };
    }
  } catch {
    return { version: 1, people: {} };
  }
  return { version: 1, people: {} };
}

function writeState(file: string, state: PeopleState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function createPeopleDirectory(deps: PeopleDirectoryDeps): PeopleDirectory {
  const now = deps.now ?? Date.now;
  let state = readState(deps.stateFile);
  let collaboratorCache: { at: number; people: RepoCollaborator[] } | undefined;
  let collaboratorFetch: Promise<RepoCollaborator[]> | undefined;

  async function collaborators(): Promise<RepoCollaborator[]> {
    if (deps.collaborators === undefined) return [];
    const at = now();
    if (collaboratorCache !== undefined && at - collaboratorCache.at < COLLABORATOR_CACHE_MS) {
      return collaboratorCache.people;
    }
    collaboratorFetch ??= deps
      .collaborators()
      .then((people) => {
        collaboratorCache = { at: now(), people };
        return people;
      })
      .catch((err: unknown) => {
        deps.onError?.(err);
        collaboratorCache = { at: now(), people: collaboratorCache?.people ?? [] };
        return collaboratorCache.people;
      })
      .finally(() => {
        collaboratorFetch = undefined;
      });
    return collaboratorFetch;
  }

  return {
    remember(user) {
      const key = String(user.id);
      const known = state.people[key];
      const at = now();
      if (
        known !== undefined &&
        known.login === user.login &&
        known.name === user.name &&
        known.avatarUrl === user.avatarUrl &&
        at - Date.parse(known.lastSeen) < REMEMBER_GAP_MS
      ) {
        return;
      }
      const people = {
        ...state.people,
        [key]: {
          id: user.id,
          login: user.login,
          name: user.name,
          avatarUrl: user.avatarUrl,
          lastSeen: new Date(at).toISOString(),
        },
      };
      const entries = Object.entries(people);
      if (entries.length > MAX_PEOPLE) {
        entries.sort(([, a], [, b]) => (a.lastSeen < b.lastSeen ? 1 : -1));
        state = { version: 1, people: Object.fromEntries(entries.slice(0, MAX_PEOPLE)) };
      } else {
        state = { version: 1, people };
      }
      try {
        writeState(deps.stateFile, state);
      } catch (err) {
        deps.onError?.(err);
      }
    },
    async list() {
      const byLogin = new Map<string, Person>();
      const add = (person: Person) => {
        const key = person.login.toLowerCase();
        const existing = byLogin.get(key);
        byLogin.set(key, {
          login: existing?.login ?? person.login,
          ...((existing?.name ?? person.name) ? { name: existing?.name ?? person.name } : {}),
          ...((existing?.avatarUrl ?? person.avatarUrl)
            ? { avatarUrl: existing?.avatarUrl ?? person.avatarUrl }
            : {}),
        });
      };
      for (const person of Object.values(state.people)) {
        add({ login: person.login, name: person.name, avatarUrl: person.avatarUrl });
      }
      for (const collaborator of await collaborators()) {
        add({ login: collaborator.login, avatarUrl: collaborator.avatarUrl });
      }
      for (const login of deps.allowedLogins ?? []) add({ login });
      return [...byLogin.values()].sort((a, b) =>
        (a.name ?? a.login).localeCompare(b.name ?? b.login, 'en', { sensitivity: 'base' }),
      );
    },
  };
}
