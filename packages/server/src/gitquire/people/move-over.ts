import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { SealedKeyStore } from '../chat/key-store.ts';
import { chatKeysDir, createChatKeyStore } from '../chat/key-store.ts';
import { CHAT_PROVIDERS, type ChatProvider } from '../chat/models.ts';
import { usageEntryOf } from '../chat/usage.ts';
import { draftsStatePath } from '../drafts/store.ts';
import { mentionStatePath } from '../mentions.ts';
import type { PersonUsageEntry } from './chat-data.ts';
import { readMailRecord, updateMailRecord } from './mail.ts';
import { mailedIds, markMailed } from './mailer.ts';
import { type AgentMode, isAgentMode } from './settings.ts';
import { type PeopleStore, SETTINGS_FILE } from './store.ts';

export const MOVED_FILE = 'moved.json';

export interface WikiPeopleSource {
  dir: string;
  wikiKey: string;
  idPrefix: string;
  keySecrets: readonly string[];
}

export interface MoveOverTarget {
  store: PeopleStore;
  keys?: SealedKeyStore;
  markExisting?: (person: string, login: string, wikiKey: string, before?: string) => void;
  wikiKeys?: () => readonly string[];
  now?: () => number;
}

export interface PeopleMoveReport {
  wikis: string[];
  failed: string[];
  people: number;
  addresses: number;
  keys: number;
  unreadableKeys: number;
}

interface OldUser {
  login?: string;
  email?: string;
  since?: string;
  lastSeen?: string;
  mailed: string[];
}

interface Moved {
  wikis: Record<string, string>;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function oldUsers(dir: string): Map<number, OldUser> {
  const raw = readJson(mentionStatePath(dir)) as { users?: Record<string, unknown> } | undefined;
  const out = new Map<number, OldUser>();
  for (const [id, entry] of Object.entries(raw?.users ?? {})) {
    const userId = Number(id);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const user: OldUser = {
      mailed: Array.isArray(r.mailed)
        ? r.mailed.filter((x): x is string => typeof x === 'string')
        : [],
    };
    const login = text(r.login);
    if (login !== undefined) user.login = login;
    const email = text(r.email);
    if (email !== undefined) user.email = email;
    const since = text(r.since);
    if (since !== undefined) user.since = since;
    const lastSeen = text(r.lastSeen);
    if (lastSeen !== undefined) user.lastSeen = lastSeen;
    out.set(userId, user);
  }
  return out;
}

function numberedFiles(dir: string, extension: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const match = new RegExp(`^([1-9][0-9]*)\\${extension}$`).exec(name);
    return match === null ? [] : [Number(match[1])];
  });
}

function settingsDir(dir: string): string {
  return join(dir, '.gitquire', 'local', 'gitquire', 'users');
}

function usageDir(dir: string): string {
  return join(dir, '.gitquire', 'local', 'gitquire', 'chat-usage');
}

function readMoved(store: PeopleStore): Moved {
  const raw = readJson(join(store.root, MOVED_FILE)) as Partial<Moved> | undefined;
  return { wikis: typeof raw?.wikis === 'object' && raw.wikis !== null ? raw.wikis : {} };
}

export function movedWikis(store: PeopleStore): Set<string> {
  return new Set(Object.keys(readMoved(store).wikis));
}

interface Candidate<T> {
  value: T;
  at: number;
}

function later<T>(current: Candidate<T> | undefined, next: Candidate<T>): Candidate<T> {
  return current === undefined || next.at > current.at ? next : current;
}

export function movePeopleData(
  sources: readonly WikiPeopleSource[],
  target: MoveOverTarget,
  writeMoved: (moved: Moved) => void = writeMovedFile(target.store),
): PeopleMoveReport {
  const now = target.now ?? Date.now;
  const done = movedWikis(target.store);
  const todo = sources.filter((source) => !done.has(source.wikiKey));
  const report: PeopleMoveReport = {
    wikis: [],
    failed: [],
    people: 0,
    addresses: 0,
    keys: 0,
    unreadableKeys: 0,
  };
  if (todo.length === 0) return report;

  const touched = new Set<string>();
  const subscribedIn = new Map<string, Set<string>>();
  const addresses = new Map<string, Candidate<{ address: string; since: string }>>();
  const earliest = new Map<string, string>();
  const lastSeen = new Map<string, string>();
  const logins = new Map<string, string>();
  const settings = new Map<string, Candidate<string>>();
  const modes = new Map<string, Candidate<AgentMode>>();
  const keys = new Map<string, Candidate<string>>();
  const sinceIn = new Map<string, Map<string, string>>();

  for (const source of todo) {
    try {
      readSource(source);
      report.wikis.push(source.wikiKey);
    } catch {
      report.failed.push(source.wikiKey);
    }
  }

  function readSource(source: WikiPeopleSource): void {
    const person = (id: number) => `${source.idPrefix}${id}`;
    for (const [id, user] of oldUsers(source.dir)) {
      const who = person(id);
      touched.add(who);
      if (user.login !== undefined) logins.set(who, user.login);
      if (user.mailed.length > 0) markMailed(target.store, who, source.wikiKey, user.mailed);
      if (user.lastSeen !== undefined && user.lastSeen > (lastSeen.get(who) ?? '')) {
        lastSeen.set(who, user.lastSeen);
      }
      if (user.email === undefined || user.since === undefined) continue;
      const at = Date.parse(user.since);
      if (Number.isNaN(at)) continue;
      subscribedIn.set(who, new Set([...(subscribedIn.get(who) ?? []), source.wikiKey]));
      const ownSince = sinceIn.get(who) ?? new Map<string, string>();
      ownSince.set(source.wikiKey, user.since);
      sinceIn.set(who, ownSince);
      addresses.set(
        who,
        later(addresses.get(who), { value: { address: user.email, since: user.since }, at }),
      );
      const first = earliest.get(who);
      if (first === undefined || user.since < first) earliest.set(who, user.since);
    }
    for (const id of numberedFiles(settingsDir(source.dir), '.yml')) {
      const file = join(settingsDir(source.dir), `${id}.yml`);
      const at = mtimeOf(file);
      if (at === undefined) continue;
      touched.add(person(id));
      settings.set(
        person(id),
        later(settings.get(person(id)), { value: readFileSync(file, 'utf8'), at }),
      );
    }
    const draftsFile = draftsStatePath(source.dir);
    const draftsAt = mtimeOf(draftsFile);
    const agentModes = (
      readJson(draftsFile) as { agentModes?: Record<string, unknown> } | undefined
    )?.agentModes;
    if (draftsAt !== undefined && agentModes !== undefined) {
      for (const [id, mode] of Object.entries(agentModes)) {
        if (!isAgentMode(mode) || !/^[1-9][0-9]*$/.test(id)) continue;
        const who = person(Number(id));
        touched.add(who);
        modes.set(who, later(modes.get(who), { value: mode, at: draftsAt }));
      }
    }
    for (const id of numberedFiles(chatKeysDir(source.dir), '.json')) {
      const who = person(id);
      const opened = source.keySecrets
        .filter((secret) => secret.length >= 32)
        .map((secret) => createChatKeyStore(source.dir, secret));
      for (const provider of CHAT_PROVIDERS) {
        const found = opened
          .map((store) => ({ key: store.get(id, provider), info: store.info(id)[provider] }))
          .find((item) => item.key !== undefined);
        const stored = opened[0]?.info(id)[provider];
        if (found?.key === undefined) {
          if (stored?.savedAt !== null && stored?.savedAt !== undefined) report.unreadableKeys += 1;
          continue;
        }
        touched.add(who);
        const at = found.info.savedAt === null ? 0 : Date.parse(found.info.savedAt);
        keys.set(
          `${who}\n${provider}`,
          later(keys.get(`${who}\n${provider}`), { value: found.key, at }),
        );
      }
    }
    for (const id of numberedFiles(usageDir(source.dir), '.json')) {
      const raw = readJson(join(usageDir(source.dir), `${id}.json`)) as
        | { entries?: unknown[] }
        | undefined;
      const entries = (raw?.entries ?? []).flatMap((item) => {
        const entry = usageEntryOf(item);
        return entry === undefined ? [] : [{ ...entry, wiki: source.wikiKey }];
      });
      if (entries.length === 0) continue;
      const who = person(id);
      touched.add(who);
      target.store.updateJson(
        who,
        'usage.json',
        (value) => {
          const list = (value as { entries?: PersonUsageEntry[] } | undefined)?.entries;
          return { entries: Array.isArray(list) ? list : [] };
        },
        (file) =>
          file.entries.some((entry) => entry.wiki === source.wikiKey)
            ? file
            : { entries: [...file.entries, ...entries] },
      );
    }
  }

  const movedKeys = new Set(report.wikis);
  for (const who of touched) {
    const candidate = addresses.get(who);
    const before = readMailRecord(target.store, who);
    updateMailRecord(target.store, who, (record) => {
      const next = { ...record };
      const login = logins.get(who);
      if (login !== undefined && next.login === undefined) next.login = login;
      const seen = lastSeen.get(who);
      if (seen !== undefined && seen > (next.lastSeen ?? '')) next.lastSeen = seen;
      if (candidate === undefined) return next;
      const chosen = next.chosenAt === undefined ? -1 : Date.parse(next.chosenAt);
      if (candidate.at > chosen) {
        const address = candidate.value.address;
        const isAccount =
          next.account !== undefined &&
          next.account.address.toLowerCase() === address.toLowerCase();
        next.use = isAccount ? 'account' : 'other';
        next.chosenAt = new Date(candidate.at).toISOString();
        if (!isAccount) next.other = { address, confirmedAt: candidate.value.since };
        report.addresses += 1;
      }
      const first = earliest.get(who);
      if (first !== undefined && (next.since === undefined || first < next.since))
        next.since = first;
      return next;
    });
    const setting = settings.get(who);
    const settingsAt = target.store.changedAt(who, SETTINGS_FILE);
    if (setting !== undefined && settingsAt === undefined) {
      target.store.writeText(who, SETTINGS_FILE, setting.value);
    }
    const mode = modes.get(who);
    if (mode !== undefined) {
      target.store.updateJson(
        who,
        'prefs.json',
        (raw) => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}),
        (prefs) => (isAgentMode(prefs.agentMode) ? prefs : { ...prefs, agentMode: mode.value }),
      );
    }
    for (const provider of CHAT_PROVIDERS) {
      const key = keys.get(`${who}\n${provider}`);
      if (key === undefined || target.keys === undefined) continue;
      const saved = target.keys.savedAt(who, provider);
      if (saved !== undefined && Date.parse(saved) >= key.at) continue;
      target.keys.set(who, provider as ChatProvider, key.value, new Date(key.at || now()));
      report.keys += 1;
    }
    const record = readMailRecord(target.store, who);
    const switchedOn = record.use !== undefined && before.use === undefined;
    const sinceMoved = record.since !== before.since;
    if (record.use !== undefined && record.login !== undefined) {
      const own = sinceIn.get(who) ?? new Map<string, string>();
      const everyWiki = new Set([...(target.wikiKeys?.() ?? []), ...movedKeys]);
      for (const wikiKey of everyWiki) {
        if (!movedKeys.has(wikiKey) && !switchedOn && !sinceMoved) continue;
        const theirs = own.get(wikiKey);
        if (theirs === undefined) {
          target.markExisting?.(who, record.login, wikiKey);
        } else if (record.since !== undefined && theirs > record.since) {
          target.markExisting?.(who, record.login, wikiKey, theirs);
        }
        if (movedKeys.has(wikiKey) && theirs !== undefined)
          markMailed(target.store, who, wikiKey, []);
      }
    }
  }
  report.people = touched.size;
  if (touched.size === 0 && !existsSync(target.store.root)) return report;
  const moved = readMoved(target.store);
  const at = new Date(now()).toISOString();
  for (const key of movedKeys) moved.wikis[key] = at;
  writeMoved(moved);
  return report;
}

export const SINGLE_WIKI_KEY = 'wiki';

export function writeMovedFile(store: PeopleStore): (moved: Moved) => void {
  return (moved) => {
    mkdirSync(store.root, { recursive: true, mode: 0o700 });
    const file = join(store.root, MOVED_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(moved)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  };
}

export function markWikisMoved(store: PeopleStore, keys: readonly string[], at: Date): void {
  const moved = readMoved(store);
  for (const key of keys) moved.wikis[key] ??= at.toISOString();
  writeMovedFile(store)(moved);
}

function copyIfAbsent(from: string, to: string): boolean {
  if (!existsSync(from) || existsSync(to)) return false;
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, to);
  chmodSync(to, 0o600);
  return true;
}

export function copyPeopleForWiki(
  from: PeopleStore,
  to: PeopleStore,
  fromWiki: string,
  toWiki: string,
): number {
  let people = 0;
  for (const person of from.people()) {
    people += 1;
    for (const file of ['mail.json', 'prefs.json', 'ai-keys.json', SETTINGS_FILE] as const) {
      copyIfAbsent(join(from.root, person, file), join(to.root, person, file));
    }
    const mailed = [...mailedIds(from, person, fromWiki)];
    if (mailed.length > 0) markMailed(to, person, toWiki, mailed);
    const entries = from
      .readJson(person, 'usage.json', (raw) => {
        const list = (raw as { entries?: PersonUsageEntry[] } | undefined)?.entries;
        return Array.isArray(list) ? list : [];
      })
      .filter((entry) => entry.wiki === fromWiki)
      .map((entry) => ({ ...entry, wiki: toWiki }));
    if (entries.length > 0) {
      to.updateJson(
        person,
        'usage.json',
        (raw) => {
          const list = (raw as { entries?: PersonUsageEntry[] } | undefined)?.entries;
          return { entries: Array.isArray(list) ? list : [] };
        },
        (file) =>
          file.entries.some((entry) => entry.wiki === toWiki)
            ? file
            : { entries: [...file.entries, ...entries] },
      );
    }
  }
  return people;
}
