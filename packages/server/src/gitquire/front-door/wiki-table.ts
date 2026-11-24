import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HostRepo, HostRepoRecord } from '../host/types.ts';
import { hostKeyOf } from './hosts.ts';

type DisconnectReason = 'token' | 'not-admin' | 'removed' | 'gone' | 'owner-not-allowed';

export interface WikiRecord extends HostRepoRecord {
  hostKey?: string;
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
  byId: (hostKey: string, id: number) => WikiRecord | undefined;
  byAddress: (hostKey: string, owner: string, name: string) => AddressMatch | undefined;
  byOldAddress: (owner: string, name: string) => AddressMatch | undefined;
  add: (repo: HostRepoRecord, addedBy: string, now: number, hostKey?: string) => WikiRecord;
  rename: (key: string, to: HostRepo, ownerId?: number) => WikiRecord | undefined;
  connect: (key: string) => WikiRecord | undefined;
  disconnect: (key: string, reason: DisconnectReason) => WikiRecord | undefined;
  remove: (key: string) => WikiRecord | undefined;
  ownerIds: () => Readonly<Record<string, number>>;
  pinOwner: (owner: string, id: number) => void;
  hostOwnerIds: (hostKey: string) => Readonly<Record<string, number>>;
  pinHostOwner: (hostKey: string, owner: string, id: number) => void;
}

interface TableFile {
  version: 1;
  wikis: WikiRecord[];
  owners: Record<string, number>;
  hostOwners?: Record<string, Record<string, number>>;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function wikiKey(repo: Pick<HostRepoRecord, 'host' | 'id'>, hostKey?: string): string {
  const key = `${hostKey ?? repo.host}-${repo.id}`;
  if (!KEY_RE.test(key)) throw new Error(`"${key}" cannot name a wiki.`);
  return key;
}

export function wikiDir(dataDir: string, wiki: Pick<WikiRecord, 'key'>): string {
  return join(dataDir, 'wikis', wiki.key);
}

export function wikiPrefix(wiki: HostRepo & Pick<WikiRecord, 'host' | 'hostKey'>): string {
  return `/w/${hostKeyOf(wiki)}/${wiki.owner}/${wiki.name}`;
}

export function wikiName(wiki: HostRepo & Pick<WikiRecord, 'host' | 'hostKey'>): string {
  return `${hostKeyOf(wiki)}/${wiki.owner}/${wiki.name}`;
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
    (v.hostKey === undefined || typeof v.hostKey === 'string') &&
    typeof v.id === 'number' &&
    typeof v.owner === 'string' &&
    typeof v.ownerId === 'number' &&
    typeof v.name === 'string' &&
    typeof v.key === 'string' &&
    (v.state === 'on' || v.state === 'disconnected') &&
    Array.isArray(v.formerNames)
  );
}

function ownerMap(raw: unknown): Record<string, number> {
  const owners: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null) return owners;
  for (const [name, id] of Object.entries(raw)) {
    if (typeof id === 'number') owners[name.toLowerCase()] = id;
  }
  return owners;
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
  const owners = ownerMap(parsed.owners);
  if (parsed.hostOwners === undefined) return { version: 1, wikis, owners };
  const hostOwners: Record<string, Record<string, number>> = {};
  for (const [key, map] of Object.entries(parsed.hostOwners ?? {})) {
    hostOwners[key] = ownerMap(map);
  }
  return { version: 1, wikis, owners, hostOwners };
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
    byId: (hostKey, id) =>
      state.wikis.find((wiki) => hostKeyOf(wiki) === hostKey && wiki.id === id),
    byAddress: (hostKey, owner, name) => {
      const wanted = { owner, name };
      const onHost = state.wikis.filter((wiki) => hostKeyOf(wiki) === hostKey);
      const current = onHost.find((wiki) => same(wiki, wanted));
      if (current !== undefined) return { wiki: current, current: true };
      const former = onHost.find((wiki) => wiki.formerNames.some((old) => same(old, wanted)));
      return former === undefined ? undefined : { wiki: former, current: false };
    },
    byOldAddress: (owner, name) => {
      const wanted = { owner, name };
      const current = state.wikis.filter((wiki) => same(wiki, wanted));
      const holders =
        current.length > 0
          ? current
          : state.wikis.filter((wiki) => wiki.formerNames.some((old) => same(old, wanted)));
      const first = holders.reduce<WikiRecord | undefined>(
        (earliest, wiki) =>
          earliest === undefined || wiki.addedAt < earliest.addedAt ? wiki : earliest,
        undefined,
      );
      return first === undefined ? undefined : { wiki: first, current: false };
    },
    add: (repo, addedBy, now, hostKey) => {
      const key = wikiKey(repo, hostKey);
      const existing = byKey(key);
      if (existing !== undefined) return existing;
      const wiki: WikiRecord = {
        host: repo.host,
        ...(hostKey === undefined || hostKey === repo.host ? {} : { hostKey }),
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
    remove: (key) => {
      const wiki = byKey(key);
      if (wiki === undefined) return undefined;
      state.wikis = state.wikis.filter((other) => other.key !== key);
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
    hostOwnerIds: (hostKey) => state.hostOwners?.[hostKey] ?? {},
    pinHostOwner: (hostKey, owner, id) => {
      const name = owner.toLowerCase();
      const pins = state.hostOwners?.[hostKey] ?? {};
      if (pins[name] !== undefined) return;
      state.hostOwners = { ...state.hostOwners, [hostKey]: { ...pins, [name]: id } };
      save();
    },
  };
}
