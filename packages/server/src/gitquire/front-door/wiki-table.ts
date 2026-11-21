import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HostKind, HostRepo, HostRepoRecord } from '../host/types.ts';

type DisconnectReason = 'token' | 'not-admin' | 'removed' | 'gone' | 'owner-not-allowed';

export interface WikiRecord extends HostRepoRecord {
  key: string;
  state: 'on' | 'disconnected';
  reason?: DisconnectReason;
  formerNames: HostRepo[];
  addedBy: string;
  addedAt: string;
}

interface AddressMatch {
  wiki: WikiRecord;
  current: boolean;
}

export interface WikiTable {
  list: () => readonly WikiRecord[];
  byKey: (key: string) => WikiRecord | undefined;
  byId: (host: HostKind, id: number) => WikiRecord | undefined;
  byAddress: (owner: string, name: string) => AddressMatch | undefined;
  add: (repo: HostRepoRecord, addedBy: string, now: number) => WikiRecord;
  rename: (key: string, to: HostRepo, ownerId?: number) => WikiRecord | undefined;
  connect: (key: string) => WikiRecord | undefined;
  disconnect: (key: string, reason: DisconnectReason) => WikiRecord | undefined;
  ownerIds: () => Readonly<Record<string, number>>;
  pinOwner: (owner: string, id: number) => void;
}

interface TableFile {
  version: 1;
  wikis: WikiRecord[];
  owners: Record<string, number>;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function wikiKey(repo: Pick<HostRepoRecord, 'host' | 'id'>): string {
  const key = `${repo.host}-${repo.id}`;
  if (!KEY_RE.test(key)) throw new Error(`"${key}" cannot name a wiki.`);
  return key;
}

export function wikiDir(dataDir: string, wiki: Pick<WikiRecord, 'key'>): string {
  return join(dataDir, 'wikis', wiki.key);
}

export function wikiPrefix(wiki: HostRepo): string {
  return `/w/${wiki.owner}/${wiki.name}`;
}

function same(a: HostRepo, b: HostRepo): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
  );
}

function isRecord(value: unknown): value is WikiRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.host === 'github' || v.host === 'forgejo') &&
    typeof v.id === 'number' &&
    typeof v.owner === 'string' &&
    typeof v.ownerId === 'number' &&
    typeof v.name === 'string' &&
    typeof v.key === 'string' &&
    (v.state === 'on' || v.state === 'disconnected') &&
    Array.isArray(v.formerNames)
  );
}

function load(file: string): TableFile {
  if (!existsSync(file)) return { version: 1, wikis: [], owners: {} };
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TableFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.wikis)) {
    throw new Error(`${file} is not a GitQuire wiki table.`);
  }
  const wikis = parsed.wikis.filter(isRecord);
  if (wikis.length !== parsed.wikis.length) {
    throw new Error(`${file} has wiki records GitQuire cannot read.`);
  }
  const owners: Record<string, number> = {};
  for (const [name, id] of Object.entries(parsed.owners ?? {})) {
    if (typeof id === 'number') owners[name.toLowerCase()] = id;
  }
  return { version: 1, wikis, owners };
}

export function wikiTableFile(dataDir: string): string {
  return join(dataDir, 'server', 'wikis.json');
}

export function openWikiTable(file: string): WikiTable {
  const state = load(file);

  function save(): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }

  function byKey(key: string): WikiRecord | undefined {
    return state.wikis.find((wiki) => wiki.key === key);
  }

  function change(key: string, apply: (wiki: WikiRecord) => void): WikiRecord | undefined {
    const wiki = byKey(key);
    if (wiki === undefined) return undefined;
    apply(wiki);
    save();
    return wiki;
  }

  return {
    list: () => state.wikis,
    byKey,
    byId: (host, id) => state.wikis.find((wiki) => wiki.host === host && wiki.id === id),
    byAddress: (owner, name) => {
      const wanted = { owner, name };
      const current = state.wikis.find((wiki) => same(wiki, wanted));
      if (current !== undefined) return { wiki: current, current: true };
      const former = state.wikis.find((wiki) => wiki.formerNames.some((old) => same(old, wanted)));
      return former === undefined ? undefined : { wiki: former, current: false };
    },
    add: (repo, addedBy, now) => {
      const key = wikiKey(repo);
      const existing = byKey(key);
      if (existing !== undefined) return existing;
      const wiki: WikiRecord = {
        host: repo.host,
        id: repo.id,
        owner: repo.owner,
        ownerId: repo.ownerId,
        name: repo.name,
        key,
        state: 'on',
        formerNames: [],
        addedBy,
        addedAt: new Date(now).toISOString(),
      };
      state.wikis.push(wiki);
      save();
      return wiki;
    },
    rename: (key, to, ownerId) =>
      change(key, (wiki) => {
        const old = { owner: wiki.owner, name: wiki.name };
        if (!same(old, to) && !wiki.formerNames.some((name) => same(name, old))) {
          wiki.formerNames.push(old);
        }
        wiki.formerNames = wiki.formerNames.filter((name) => !same(name, to));
        wiki.owner = to.owner;
        wiki.name = to.name;
        if (ownerId !== undefined) wiki.ownerId = ownerId;
      }),
    connect: (key) =>
      change(key, (wiki) => {
        wiki.state = 'on';
        delete wiki.reason;
      }),
    disconnect: (key, reason) =>
      change(key, (wiki) => {
        wiki.state = 'disconnected';
        wiki.reason = reason;
      }),
    ownerIds: () => state.owners,
    pinOwner: (owner, id) => {
      const name = owner.toLowerCase();
      if (state.owners[name] === id) return;
      if (state.owners[name] !== undefined) return;
      state.owners[name] = id;
      save();
    },
  };
}
