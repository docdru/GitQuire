import { join } from 'node:path';
import { CHAT_RETENTION_DAYS } from '../chat/history.ts';
import {
  createSealedKeyStore,
  InvalidApiKeyError,
  normalizeApiKey,
  type SealedKeyStore,
} from '../chat/key-store.ts';
import { isChatProvider } from '../chat/models.ts';
import { cutoffDay, type UsageEntry, usageEntryOf, usageReport, withUsage } from '../chat/usage.ts';
import type { PersonAnswer, PersonQuestion } from '../front-door/person-socket.ts';
import type { PeopleStore } from './store.ts';

export interface PersonUsageEntry extends UsageEntry {
  wiki: string;
}

function parseUsage(raw: unknown): PersonUsageEntry[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: PersonUsageEntry[] = [];
  for (const item of entries) {
    const entry = usageEntryOf(item);
    const wiki = (item as { wiki?: unknown }).wiki;
    if (entry !== undefined && typeof wiki === 'string') out.push({ ...entry, wiki });
  }
  return out;
}

export function personKeyStore(store: PeopleStore, secret: string): SealedKeyStore {
  return createSealedKeyStore((person) => join(store.root, person, 'ai-keys.json'), secret);
}

export interface PersonChatData {
  answer: (question: PersonQuestion) => PersonAnswer;
  addUsage: (person: string, wiki: string, entry: UsageEntry, now: Date) => void;
}

export function personChatData(
  store: PeopleStore,
  keys: SealedKeyStore,
  options: { retentionDays?: number; now?: () => Date } = {},
): PersonChatData {
  const retention = options.retentionDays ?? CHAT_RETENTION_DAYS;
  const now = options.now ?? (() => new Date());

  function addUsage(person: string, wiki: string, entry: UsageEntry, at: Date): void {
    const cutoff = cutoffDay(at, retention);
    store.updateJson(
      person,
      'usage.json',
      (raw) => ({ entries: parseUsage(raw) }),
      (file) => {
        const kept = file.entries.filter((existing) => existing.day >= cutoff);
        const next = withUsage<PersonUsageEntry>(
          kept,
          { ...entry, wiki },
          (a, b) => a.wiki === b.wiki,
        );
        return { entries: next ?? kept };
      },
    );
  }

  function answer(question: PersonQuestion): PersonAnswer {
    const { person, wikiKey, method, path, body } = question;
    if (path === 'ai-keys' && method === 'GET') {
      return { status: 200, body: keys.info(person) };
    }
    const keyPath = /^ai-keys\/([a-z]+)$/.exec(path);
    if (keyPath !== null) {
      const provider = keyPath[1];
      if (!isChatProvider(provider)) return { status: 400, body: { error: 'invalid-provider' } };
      if (method === 'GET')
        return { status: 200, body: { key: keys.get(person, provider) ?? null } };
      if (method === 'DELETE') {
        keys.remove(person, provider);
        return { status: 200, body: { removed: true } };
      }
      if (method === 'PUT') {
        try {
          return {
            status: 200,
            body: keys.set(person, provider, normalizeApiKey(body.key), now()),
          };
        } catch (err) {
          if (err instanceof InvalidApiKeyError)
            return { status: 400, body: { error: 'invalid-key' } };
          throw err;
        }
      }
    }
    if (path === 'ai-usage' && method === 'POST') {
      const entry = usageEntryOf(body.entry);
      if (entry === undefined) return { status: 400, body: { error: 'invalid-usage' } };
      addUsage(person, wikiKey, entry, now());
      return { status: 200, body: { recorded: true } };
    }
    if (path === 'ai-usage' && method === 'GET') {
      const entries = store.readJson(person, 'usage.json', parseUsage);
      return {
        status: 200,
        body: usageReport(
          entries,
          now(),
          retention,
          (entry) => (entry as PersonUsageEntry).wiki === wikiKey,
        ),
      };
    }
    return undefined;
  }

  return { answer, addUsage };
}
