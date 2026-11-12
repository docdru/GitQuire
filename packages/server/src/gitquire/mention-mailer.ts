import type { GateLogger } from './access-gate.ts';
import { isPermanentMailFailure, type MailConfig, type MailMessage } from './mail.ts';
import {
  type MailSubscriber,
  type Mention,
  type MentionIndex,
  type MentionReadStore,
  mentionsFor,
} from './mentions.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_NAME_CHARS = 80;

export interface MailLimits {
  perPersonPerRound: number;
  perPersonPerDay: number;
  perHour: number;
  idleDays: number;
  clockSlackMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_MAIL_LIMITS: MailLimits = {
  perPersonPerRound: 5,
  perPersonPerDay: 20,
  perHour: 100,
  idleDays: 30,
  clockSlackMs: 5 * MINUTE_MS,
  maxBackoffMs: HOUR_MS,
};

export interface MentionMailerDeps {
  index: MentionIndex;
  store: MentionReadStore;
  config: MailConfig;
  send: (config: MailConfig, message: MailMessage) => Promise<void>;
  log: Pick<GateLogger, 'warn'>;
  now?: () => number;
  limits?: Partial<MailLimits>;
}

export interface MentionMailer {
  round: () => Promise<number>;
}

export function pageLink(externalUrl: string | undefined, docName: string): string | undefined {
  if (externalUrl === undefined) return undefined;
  const route = docName.split('/').map(encodeURIComponent).join('/');
  return `${externalUrl}/#/${route}`;
}

function clipName(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_NAME_CHARS ? flat : `${flat.slice(0, MAX_NAME_CHARS - 1)}…`;
}

export function mentionMail(
  config: Pick<MailConfig, 'externalUrl'>,
  to: string,
  mention: Mention,
): MailMessage {
  const who = clipName(mention.author.name ?? mention.author.login ?? '') || 'Someone';
  const page = clipName(mention.docName.slice(mention.docName.lastIndexOf('/') + 1));
  const link = pageLink(config.externalUrl, mention.docName);
  const lines = [
    `${who} mentioned you in "${page}".`,
    '',
    `On the text: "${mention.quote}"`,
    '',
    mention.body,
  ];
  if (link !== undefined) lines.push('', `Open the page: ${link}`);
  lines.push(
    '',
    'You get this mail because you entered this address for mentions in GitQuire.',
    'To stop, open the mention list in GitQuire and choose "Stop emailing me".',
  );
  return { to, subject: `${who} mentioned you in ${page}`, text: `${lines.join('\n')}\n` };
}

function recent(times: readonly number[], now: number, windowMs: number): number[] {
  return times.filter((time) => now - time < windowMs);
}

export function createMentionMailer(deps: MentionMailerDeps): MentionMailer {
  const limits: MailLimits = { ...DEFAULT_MAIL_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const sentByPerson = new Map<number, number[]>();
  const failures = new Map<number, { count: number; retryAt: number }>();
  let sentOverall: number[] = [];
  let running = false;

  function mayMail(subscriber: MailSubscriber, at: number): boolean {
    sentOverall = recent(sentOverall, at, HOUR_MS);
    const mine = recent(sentByPerson.get(subscriber.id) ?? [], at, DAY_MS);
    sentByPerson.set(subscriber.id, mine);
    return sentOverall.length < limits.perHour && mine.length < limits.perPersonPerDay;
  }

  function due(subscriber: MailSubscriber, all: readonly Mention[], at: number): Mention[] {
    if (at - Date.parse(subscriber.lastSeen) > limits.idleDays * DAY_MS) return [];
    if ((failures.get(subscriber.id)?.retryAt ?? 0) > at) return [];
    const earliest = new Date(Date.parse(subscriber.since) - limits.clockSlackMs).toISOString();
    const mailed = deps.store.mailedIds(subscriber.id);
    const read = deps.store.readIds(subscriber.id);
    return mentionsFor(subscriber, all)
      .filter((mention) => mention.at >= earliest && !mailed.has(mention.id))
      .filter((mention) => !read.has(mention.id))
      .slice(0, limits.perPersonPerRound);
  }

  async function mailOne(subscriber: MailSubscriber, mention: Mention): Promise<boolean> {
    const at = now();
    try {
      await deps.send(deps.config, mentionMail(deps.config, subscriber.email, mention));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (isPermanentMailFailure(err)) {
        deps.store.markMailed(subscriber.id, [mention.id]);
        deps.log.warn({ reason, login: subscriber.login }, '[gitquire-mail] mention email refused');
        return false;
      }
      const count = (failures.get(subscriber.id)?.count ?? 0) + 1;
      const wait = Math.min(limits.maxBackoffMs, MINUTE_MS * 2 ** count);
      failures.set(subscriber.id, { count, retryAt: at + wait });
      deps.log.warn({ reason, login: subscriber.login }, '[gitquire-mail] mention email failed');
      throw err;
    }
    failures.delete(subscriber.id);
    deps.store.markMailed(subscriber.id, [mention.id]);
    sentOverall.push(at);
    sentByPerson.set(subscriber.id, [...(sentByPerson.get(subscriber.id) ?? []), at]);
    return true;
  }

  async function mailSubscriber(
    subscriber: MailSubscriber,
    all: readonly Mention[],
  ): Promise<number> {
    let sent = 0;
    for (const mention of due(subscriber, all, now())) {
      if (!mayMail(subscriber, now())) break;
      if (deps.store.emailOf(subscriber.id) !== subscriber.email) break;
      try {
        if (await mailOne(subscriber, mention)) sent += 1;
      } catch {
        break;
      }
    }
    return sent;
  }

  async function round(): Promise<number> {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
      const subscribers = deps.store.subscribers();
      if (subscribers.length === 0) return 0;
      const all = deps.index.all();
      for (const subscriber of subscribers) {
        sent += await mailSubscriber(subscriber, all);
      }
    } finally {
      running = false;
    }
    return sent;
  }

  return { round };
}
