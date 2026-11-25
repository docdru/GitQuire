import type { BotAccess, DoorHost, Refusal, RepoAccess } from '../host/types.ts';
import type { WikiRecord } from './wiki-table.ts';

export const ACCESS_TTL_MS = 5 * 60 * 1000;
const UNREACHABLE_RETRY_MS = 30 * 1000;

export interface DecideOptions {
  strict?: boolean;
}

export interface DoorPerson {
  id: number;
  login: string;
}

type ClosedReason = 'no-access' | 'disconnected' | 'unreachable';

export type OpenDecision = { open: true; admin: boolean } | { open: false; why: ClosedReason };

interface ListedWiki {
  wiki: WikiRecord;
  admin: boolean;
}

export interface WikiAccess {
  signIn: (person: DoorPerson, personToken: string, wikis: readonly WikiRecord[]) => Promise<void>;
  decide: (person: DoorPerson, wiki: WikiRecord, options?: DecideOptions) => Promise<OpenDecision>;
  wikisFor: (
    person: DoorPerson,
    wikis: readonly WikiRecord[],
    options?: { serverAdmin?: boolean },
  ) => Promise<ListedWiki[]>;
  wasAdmin: (person: DoorPerson, wiki: WikiRecord) => boolean;
  learn: (person: DoorPerson, wiki: WikiRecord, level: RepoAccess) => void;
  forget: (person: DoorPerson) => void;
}

export interface WikiAccessDeps {
  host: Pick<DoorHost, 'access' | 'accessByBot'>;
  runnable: (wiki: WikiRecord) => boolean;
  refused: (wiki: WikiRecord, refusal: Refusal) => void;
  changed?: (wiki: WikiRecord) => void;
  now?: () => number;
  ttlMs?: number;
}

interface Entry {
  level: RepoAccess;
  checkedAt: number;
  confirmedAt: number;
}

function decisionFor(level: RepoAccess): OpenDecision {
  if (level === 'none') return { open: false, why: 'no-access' };
  return { open: true, admin: level === 'admin' };
}

function isRefusal(answer: BotAccess): answer is `refused:${Refusal}` {
  return answer.startsWith('refused:');
}

export function createWikiAccess(deps: WikiAccessDeps): WikiAccess {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? ACCESS_TTL_MS;
  const entries = new Map<number, Map<string, Entry>>();
  const asking = new Map<string, Promise<BotAccess>>();

  function entriesOf(person: DoorPerson): Map<string, Entry> {
    let found = entries.get(person.id);
    if (found === undefined) {
      found = new Map();
      entries.set(person.id, found);
    }
    return found;
  }

  function askBot(person: DoorPerson, wiki: WikiRecord): Promise<BotAccess> {
    const id = `${person.id}:${wiki.key}`;
    const running = asking.get(id);
    if (running !== undefined) return running;
    const next = deps.host
      .accessByBot(person.login, wiki)
      .catch((): BotAccess => 'unreachable')
      .finally(() => asking.delete(id));
    asking.set(id, next);
    return next;
  }

  async function decide(
    person: DoorPerson,
    wiki: WikiRecord,
    options: DecideOptions = {},
  ): Promise<OpenDecision> {
    if (wiki.state !== 'on' || !deps.runnable(wiki)) return { open: false, why: 'disconnected' };
    const mine = entriesOf(person);
    const entry = mine.get(wiki.key);
    const since = options.strict === true ? entry?.confirmedAt : entry?.checkedAt;
    if (entry !== undefined && since !== undefined && now() - since < ttl)
      return decisionFor(entry.level);
    const answer = await askBot(person, wiki);
    if (answer === 'unreachable') {
      if (options.strict !== true && entry !== undefined && entry.level !== 'none') {
        entry.checkedAt = Math.max(entry.checkedAt, now() - ttl + UNREACHABLE_RETRY_MS);
        return decisionFor(entry.level);
      }
      return { open: false, why: 'unreachable' };
    }
    if (isRefusal(answer)) {
      deps.refused(wiki, answer.slice('refused:'.length) as Refusal);
      return { open: false, why: 'disconnected' };
    }
    mine.set(wiki.key, { level: answer, checkedAt: now(), confirmedAt: now() });
    if (entry !== undefined && entry.level !== answer) deps.changed?.(wiki);
    return decisionFor(answer);
  }

  return {
    signIn: async (person, personToken, wikis) => {
      const mine = new Map<string, Entry>();
      const previous = entries.get(person.id);
      await Promise.all(
        wikis.map(async (wiki) => {
          try {
            const level = await deps.host.access(personToken, wiki);
            mine.set(wiki.key, { level, checkedAt: now(), confirmedAt: now() });
          } catch {
            const kept = previous?.get(wiki.key);
            if (kept !== undefined) mine.set(wiki.key, kept);
          }
        }),
      );
      entries.set(person.id, mine);
    },
    decide,
    wikisFor: async (person, wikis, options = {}) => {
      const listed = await Promise.all(
        wikis.map(async (wiki): Promise<ListedWiki | undefined> => {
          const decision = await decide(person, wiki);
          if (decision.open) return { wiki, admin: decision.admin };
          if (
            decision.why === 'disconnected' &&
            (options.serverAdmin === true ||
              entries.get(person.id)?.get(wiki.key)?.level === 'admin')
          ) {
            return { wiki, admin: true };
          }
          return undefined;
        }),
      );
      return listed.filter((item): item is ListedWiki => item !== undefined);
    },
    learn: (person, wiki, level) => {
      entriesOf(person).set(wiki.key, { level, checkedAt: now(), confirmedAt: now() });
    },
    wasAdmin: (person, wiki) => entries.get(person.id)?.get(wiki.key)?.level === 'admin',
    forget: (person) => {
      entries.delete(person.id);
    },
  };
}
