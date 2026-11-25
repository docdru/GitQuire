import type { GateLogger } from '../access-gate.ts';
import { isPermanentMailFailure, type MailConfig, type MailMessage } from '../mail.ts';
import { mentionMail } from '../mention-mailer.ts';
import { type Mention, mentionsFor } from '../mentions.ts';
import { mailAddressOf, readMailRecord } from './mail.ts';
import type { PeopleStore } from './store.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_MAILED_IDS = 5000;

export interface PeopleMailLimits {
  perPersonPerRound: number;
  perPersonPerDay: number;
  perHour: number;
  idleDays: number;
  clockSlackMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_PEOPLE_MAIL_LIMITS: PeopleMailLimits = {
  perPersonPerRound: 5,
  perPersonPerDay: 20,
  perHour: 100,
  idleDays: 30,
  clockSlackMs: 5 * MINUTE_MS,
  maxBackoffMs: HOUR_MS,
};

export type WikiOpen = 'open' | 'closed' | 'unknown';

export interface MailWiki {
  key: string;
  idPrefix: string;
  name: string | undefined;
  url: string | undefined;
  mentions: () => Mention[];
  readIds: (accountId: number) => Set<string>;
  canOpen: (account: { id: number; login: string }) => Promise<WikiOpen>;
}

export interface PeopleMailerDeps {
  store: PeopleStore;
  config: MailConfig | undefined;
  send: (config: MailConfig, message: MailMessage) => Promise<void>;
  wikis: () => MailWiki[];
  log: Pick<GateLogger, 'warn'>;
  now?: () => number;
  limits?: Partial<PeopleMailLimits>;
}

export interface PeopleMailer {
  round: () => Promise<number>;
  markExisting: (person: string, login: string, onlyWiki?: string) => void;
}

export function openWithin(
  decision: Promise<{ open: boolean; why?: string }>,
  ms: number,
): Promise<WikiOpen> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('unknown'), ms);
    timer.unref?.();
    decision.then(
      (answer) => {
        clearTimeout(timer);
        resolve(answer.open ? 'open' : answer.why === 'unreachable' ? 'unknown' : 'closed');
      },
      () => {
        clearTimeout(timer);
        resolve('unknown');
      },
    );
  });
}

type Mailed = Record<string, string[]>;

function parseMailed(raw: unknown): Mailed {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Mailed = {};
  for (const [key, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(ids)) out[key] = ids.filter((id): id is string => typeof id === 'string');
  }
  return out;
}

export function mailedIds(store: PeopleStore, person: string, wikiKey: string): Set<string> {
  return new Set(store.readJson(person, 'mailed.json', parseMailed)[wikiKey] ?? []);
}

export function markMailed(
  store: PeopleStore,
  person: string,
  wikiKey: string,
  ids: readonly string[],
): void {
  if (ids.length === 0) return;
  store.updateJson(person, 'mailed.json', parseMailed, (mailed) => {
    const merged = new Set(mailed[wikiKey] ?? []);
    for (const id of ids) {
      merged.delete(id);
      merged.add(id);
    }
    return { ...mailed, [wikiKey]: [...merged].slice(-MAX_MAILED_IDS) };
  });
}

function accountOf(person: string): { idPrefix: string; id: number } | undefined {
  const match = /^(.*-)([1-9][0-9]*)$/.exec(person);
  if (match === null) return undefined;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? { idPrefix: match[1] as string, id } : undefined;
}

function recent(times: readonly number[], now: number, windowMs: number): number[] {
  return times.filter((time) => now - time < windowMs);
}

export function createPeopleMailer(deps: PeopleMailerDeps): PeopleMailer {
  const limits: PeopleMailLimits = { ...DEFAULT_PEOPLE_MAIL_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const sentByPerson = new Map<string, number[]>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  let sentOverall: number[] = [];
  let running = false;

  function mayMail(person: string, at: number): boolean {
    sentOverall = recent(sentOverall, at, HOUR_MS);
    const mine = recent(sentByPerson.get(person) ?? [], at, DAY_MS);
    sentByPerson.set(person, mine);
    return sentOverall.length < limits.perHour && mine.length < limits.perPersonPerDay;
  }

  async function mailOne(
    person: string,
    login: string,
    address: string,
    wiki: MailWiki,
    mention: Mention,
  ): Promise<boolean> {
    const config = deps.config;
    if (config === undefined) return false;
    const at = now();
    const wikiConfig = {
      externalUrl: wiki.url,
      ...(wiki.name === undefined ? {} : { wiki: wiki.name }),
    };
    try {
      await deps.send(config, mentionMail(wikiConfig, address, mention));
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err))
        .split(address)
        .join('<address>');
      if (isPermanentMailFailure(err)) {
        markMailed(deps.store, person, wiki.key, [mention.id]);
        deps.log.warn({ reason, login, wiki: wiki.key }, '[gitquire-mail] mention email refused');
        return false;
      }
      const count = (failures.get(person)?.count ?? 0) + 1;
      failures.set(person, {
        count,
        retryAt: at + Math.min(limits.maxBackoffMs, MINUTE_MS * 2 ** count),
      });
      deps.log.warn({ reason, login, wiki: wiki.key }, '[gitquire-mail] mention email failed');
      throw err;
    }
    failures.delete(person);
    markMailed(deps.store, person, wiki.key, [mention.id]);
    sentOverall.push(at);
    sentByPerson.set(person, [...(sentByPerson.get(person) ?? []), at]);
    return true;
  }

  interface RoundWiki {
    wiki: MailWiki;
    mentions: () => Mention[];
    readIds: (accountId: number) => Set<string>;
  }

  function forRound(wiki: MailWiki): RoundWiki {
    let mentions: Mention[] | undefined;
    const read = new Map<number, Set<string>>();
    return {
      wiki,
      mentions: () => {
        mentions ??= wiki.mentions();
        return mentions;
      },
      readIds: (accountId) => {
        let ids = read.get(accountId);
        if (ids === undefined) {
          ids = wiki.readIds(accountId);
          read.set(accountId, ids);
        }
        return ids;
      },
    };
  }

  function dueIn(
    round: RoundWiki,
    person: string,
    account: { id: number; login: string },
    earliest: string,
  ): Mention[] {
    const mailed = mailedIds(deps.store, person, round.wiki.key);
    const read = round.readIds(account.id);
    return mentionsFor(account, round.mentions(), person).filter(
      (mention) => mention.at >= earliest && !mailed.has(mention.id) && !read.has(mention.id),
    );
  }

  function stillDue(person: string, wikiKey: string, since: string, address: string, id: string) {
    const record = readMailRecord(deps.store, person);
    return (
      record.since === since &&
      mailAddressOf(record, deps.config, now()) === address &&
      !mailedIds(deps.store, person, wikiKey).has(id)
    );
  }

  async function mailPerson(
    person: string,
    wikis: readonly RoundWiki[],
    hostsDown: Set<string>,
  ): Promise<number> {
    const account = accountOf(person);
    if (account === undefined) return 0;
    const record = readMailRecord(deps.store, person);
    const address = mailAddressOf(record, deps.config, now());
    if (address === undefined || record.login === undefined || record.since === undefined) return 0;
    const lastSeen = Date.parse(record.lastSeen ?? record.since);
    if (now() - lastSeen > limits.idleDays * DAY_MS) return 0;
    if ((failures.get(person)?.retryAt ?? 0) > now()) return 0;
    const login = record.login;
    const since = record.since;
    const reader = { id: account.id, login };
    const earliest = new Date(Date.parse(since) - limits.clockSlackMs).toISOString();
    let sent = 0;
    for (const round of wikis) {
      if (round.wiki.idPrefix !== account.idPrefix || hostsDown.has(account.idPrefix)) continue;
      const due = dueIn(round, person, reader, earliest);
      if (due.length === 0) continue;
      const open = await round.wiki.canOpen(reader);
      if (open === 'unknown') {
        hostsDown.add(account.idPrefix);
        continue;
      }
      if (open !== 'open') continue;
      for (const mention of due) {
        if (sent >= limits.perPersonPerRound || !mayMail(person, now())) return sent;
        if (!stillDue(person, round.wiki.key, since, address, mention.id)) continue;
        try {
          if (await mailOne(person, login, address, round.wiki, mention)) sent += 1;
        } catch {
          return sent;
        }
      }
    }
    return sent;
  }

  return {
    round: async () => {
      if (running || deps.config === undefined) return 0;
      running = true;
      let sent = 0;
      try {
        const wikis = deps.wikis().map(forRound);
        const hostsDown = new Set<string>();
        const byHost = new Map<string, string[]>();
        for (const person of deps.store.people()) {
          const prefix = accountOf(person)?.idPrefix;
          if (prefix === undefined) continue;
          byHost.set(prefix, [...(byHost.get(prefix) ?? []), person]);
        }
        const counts = await Promise.all(
          [...byHost.values()].map(async (people) => {
            let count = 0;
            for (const person of people) count += await mailPerson(person, wikis, hostsDown);
            return count;
          }),
        );
        sent = counts.reduce((total, count) => total + count, 0);
      } finally {
        running = false;
      }
      return sent;
    },
    markExisting: (person, login, onlyWiki) => {
      const account = accountOf(person);
      if (account === undefined) return;
      for (const wiki of deps.wikis()) {
        if (wiki.idPrefix !== account.idPrefix) continue;
        if (onlyWiki !== undefined && wiki.key !== onlyWiki) continue;
        const ids = mentionsFor({ id: account.id, login }, wiki.mentions(), person).map(
          (mention) => mention.id,
        );
        markMailed(deps.store, person, wiki.key, ids);
      }
    },
  };
}
