import { useSyncExternalStore } from 'react';

export interface Person {
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface PeopleSnapshot {
  loaded: boolean;
  people: readonly Person[];
  me: string | null;
}

const PEOPLE_URL = '/api/gitquire/people';
const REFRESH_AFTER_MS = 5 * 60 * 1000;
const LOGIN_CHARS = '[A-Za-z0-9-]';
const QUERY_RE = new RegExp(`(^|[^\\w@])@(${LOGIN_CHARS}{0,39})$`);
const EMPTY: PeopleSnapshot = { loaded: false, people: [], me: null };

export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = QUERY_RE.exec(before);
  if (match === null) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

export function matchPeople(people: readonly Person[], query: string, limit = 8): Person[] {
  const needle = query.toLowerCase();
  const scored: Array<{ person: Person; rank: number }> = [];
  for (const person of people) {
    const login = person.login.toLowerCase();
    const name = (person.name ?? '').toLowerCase();
    let rank: number;
    if (needle === '' || login.startsWith(needle)) rank = 0;
    else if (name.split(/\s+/).some((part) => part.startsWith(needle))) rank = 1;
    else if (login.includes(needle) || name.includes(needle)) rank = 2;
    else continue;
    scored.push({ person, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map(({ person }) => person);
}

export function insertMention(
  text: string,
  start: number,
  caret: number,
  login: string,
): { text: string; caret: number } {
  const after = text.slice(caret);
  const spacer = after.startsWith(' ') ? '' : ' ';
  const inserted = `@${login}${spacer}`;
  return {
    text: `${text.slice(0, start)}${inserted}${after}`,
    caret: start + inserted.length + (spacer === '' ? 1 : 0),
  };
}

export function knownLogins(people: readonly Person[]): ReadonlySet<string> {
  return new Set(people.map((person) => person.login.toLowerCase()));
}

export function personLabel(person: Person): string {
  return person.name !== undefined && person.name !== '' && person.name !== person.login
    ? `${person.name} (@${person.login})`
    : `@${person.login}`;
}

function parsePeople(body: unknown): PeopleSnapshot {
  if (typeof body !== 'object' || body === null) return { ...EMPTY, loaded: true };
  const raw = body as { people?: unknown; me?: unknown };
  const people = Array.isArray(raw.people)
    ? raw.people.flatMap((entry): Person[] => {
        const item = entry as { login?: unknown; name?: unknown; avatarUrl?: unknown };
        if (typeof item.login !== 'string' || item.login === '') return [];
        return [
          {
            login: item.login,
            ...(typeof item.name === 'string' && item.name !== '' ? { name: item.name } : {}),
            ...(typeof item.avatarUrl === 'string' && item.avatarUrl !== ''
              ? { avatarUrl: item.avatarUrl }
              : {}),
          },
        ];
      })
    : [];
  return { loaded: true, people, me: typeof raw.me === 'string' ? raw.me : null };
}

export async function fetchPeople(fetchFn: typeof fetch = fetch): Promise<PeopleSnapshot> {
  try {
    const response = await fetchFn(PEOPLE_URL, { credentials: 'same-origin' });
    if (!response.ok) return { ...EMPTY, loaded: true };
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
      return { ...EMPTY, loaded: true };
    }
    return parsePeople(await response.json());
  } catch {
    return { ...EMPTY, loaded: true };
  }
}

let current: PeopleSnapshot = EMPTY;
let pending: Promise<void> | undefined;
let loadedAt = 0;
const listeners = new Set<() => void>();

export function loadPeople(force = false): Promise<void> {
  if (pending !== undefined) return pending;
  if (!force && current.loaded && Date.now() - loadedAt < REFRESH_AFTER_MS) {
    return Promise.resolve();
  }
  pending = fetchPeople().then((next) => {
    pending = undefined;
    loadedAt = Date.now();
    current = next;
    for (const listener of listeners) listener();
  });
  return pending;
}

export function getPeopleSnapshot(): PeopleSnapshot {
  return current;
}

export function subscribePeople(onChange: () => void): () => void {
  listeners.add(onChange);
  void loadPeople();
  return () => listeners.delete(onChange);
}

export function usePeople(): PeopleSnapshot {
  return useSyncExternalStore(subscribePeople, getPeopleSnapshot, () => EMPTY);
}
