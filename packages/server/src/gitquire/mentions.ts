import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type CommentAuthor,
  readCommentThreads,
} from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import { CONFIRMATION_VALID_MS, MAX_CONFIRMATION_ATTEMPTS } from './email-confirmation.ts';
import { createPageScan, docNameForPath, type PageScan } from './page-scan.ts';

export { docNameForPath } from './page-scan.ts';

const MAX_BODY_CHARS = 280;
const MAX_QUOTE_CHARS = 140;
const MAX_READ_IDS = 5000;
const SEEN_WRITE_GAP_MS = 24 * 60 * 60 * 1000;

export interface Mention {
  id: string;
  kind?: 'comment' | 'task';
  quiet?: boolean;
  path: string;
  docName: string;
  threadId: string;
  commentId: string;
  author: CommentAuthor;
  at: string;
  body: string;
  quote: string;
  resolved: boolean;
  logins: string[];
}

export interface InboxMention extends Omit<Mention, 'logins' | 'quiet'> {
  read: boolean;
}

export interface MentionReader {
  id: number;
  login: string;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function mentionsInMarkdown(path: string, markdown: string): Mention[] {
  const found: Mention[] = [];
  const docName = docNameForPath(path) ?? path;
  for (const thread of readCommentThreads(markdown)) {
    for (const comment of thread.comments) {
      const logins = (comment.mentions ?? []).map((login) => login.toLowerCase());
      if (logins.length === 0) continue;
      found.push({
        id: `${thread.id}:${comment.id}`,
        path,
        docName,
        threadId: thread.id,
        commentId: comment.id,
        author: comment.author,
        at: comment.editedAt ?? comment.createdAt,
        body: clip(comment.body, MAX_BODY_CHARS),
        quote: clip(thread.anchor.exact, MAX_QUOTE_CHARS),
        resolved: thread.resolved,
        logins,
      });
    }
  }
  return found;
}

export interface MentionIndex {
  all: () => Mention[];
}

export function mentionIndexFrom<T>(
  scan: PageScan<T>,
  mentionsOf: (value: T) => Mention[],
): MentionIndex {
  return { all: () => scan.all().flatMap((page) => mentionsOf(page.value)) };
}

export function createMentionIndex(projectDir: string, now: () => number = Date.now): MentionIndex {
  return mentionIndexFrom(createPageScan(projectDir, mentionsInMarkdown, now), (found) => found);
}

interface PendingAddress {
  email: string;
  codeHash: string;
  sentAt: string;
  attempts: number;
}

interface UserState {
  read: string[];
  login?: string;
  email?: string;
  since?: string;
  lastSeen?: string;
  mailed?: string[];
  pending?: PendingAddress;
  confirmationsSent?: string[];
}

export type ConfirmResult = 'confirmed' | 'none' | 'expired' | 'wrong' | 'locked';

export interface PendingInfo {
  email: string;
  sentAt: string;
}

interface ReadState {
  version: 1;
  users: Record<string, UserState>;
  recipients?: Record<string, string[]>;
}

export interface MailSubscriber {
  id: number;
  login: string;
  email: string;
  since: string;
  lastSeen: string;
}

export interface MentionReadStore {
  readIds: (userId: number) => Set<string>;
  markRead: (userId: number, ids: readonly string[], known: ReadonlySet<string>) => void;
  emailOf: (userId: number) => string | undefined;
  setEmail: (
    reader: MentionReader,
    email: string | undefined,
    alreadyThere: readonly string[],
    now: Date,
  ) => void;
  seen: (reader: MentionReader, now: Date) => void;
  subscribers: () => MailSubscriber[];
  mailedIds: (userId: number) => Set<string>;
  markMailed: (userId: number, ids: readonly string[]) => void;
  pendingOf: (userId: number, now: Date) => PendingInfo | undefined;
  lastConfirmationAt: (userId: number) => string | undefined;
  confirmationsSince: (userId: number | undefined, since: Date) => number;
  recipientConfirmationsSince: (recipientKey: string, since: Date) => number;
  reserveConfirmation: (reader: MentionReader, recipientKey: string, now: Date) => void;
  startConfirmation: (reader: MentionReader, email: string, codeHash: string, now: Date) => void;
  cancelConfirmation: (userId: number) => void;
  confirm: (
    reader: MentionReader,
    codeHash: string,
    alreadyThere: readonly string[],
    now: Date,
  ) => ConfirmResult;
}

export interface ConfirmationRules {
  validMs: number;
  maxAttempts: number;
}

export function mentionStatePath(projectDir: string): string {
  return join(projectDir, '.ok', 'local', 'gitquire', 'mentions.json');
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function readUser(entry: unknown): UserState | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const raw = entry as Record<string, unknown>;
  const user: UserState = { read: stringList(raw.read) };
  if (typeof raw.login === 'string') user.login = raw.login;
  if (typeof raw.email === 'string') user.email = raw.email;
  if (typeof raw.since === 'string') user.since = raw.since;
  if (typeof raw.lastSeen === 'string') user.lastSeen = raw.lastSeen;
  if (Array.isArray(raw.mailed)) user.mailed = stringList(raw.mailed);
  if (Array.isArray(raw.confirmationsSent)) {
    user.confirmationsSent = stringList(raw.confirmationsSent);
  }
  const pending = raw.pending as Record<string, unknown> | null | undefined;
  if (
    typeof pending === 'object' &&
    pending !== null &&
    typeof pending.email === 'string' &&
    typeof pending.codeHash === 'string' &&
    typeof pending.sentAt === 'string'
  ) {
    const attempts = typeof pending.attempts === 'number' ? pending.attempts : 0;
    user.pending = {
      email: pending.email,
      codeHash: pending.codeHash,
      sentAt: pending.sentAt,
      attempts,
    };
  }
  return user;
}

function loadState(file: string): ReadState {
  const state: ReadState = { version: 1, users: {} };
  if (!existsSync(file)) return state;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return state;
    const users = (parsed as { users?: unknown }).users;
    if (typeof users !== 'object' || users === null) return state;
    for (const [userId, entry] of Object.entries(users as Record<string, unknown>)) {
      const user = readUser(entry);
      if (user !== undefined) state.users[userId] = user;
    }
    const recipients = (parsed as { recipients?: unknown }).recipients;
    if (typeof recipients === 'object' && recipients !== null) {
      state.recipients = {};
      for (const [key, stamps] of Object.entries(recipients as Record<string, unknown>)) {
        state.recipients[key] = stringList(stamps);
      }
    }
    return state;
  } catch {
    return state;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONFIRMATION_RULES: ConfirmationRules = {
  validMs: CONFIRMATION_VALID_MS,
  maxAttempts: MAX_CONFIRMATION_ATTEMPTS,
};

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createMentionReadStore(
  file: string,
  rules: ConfirmationRules = DEFAULT_CONFIRMATION_RULES,
): MentionReadStore {
  let state: ReadState | undefined;

  function current(): ReadState {
    state ??= loadState(file);
    return state;
  }

  function userState(userId: number): UserState {
    return current().users[String(userId)] ?? { read: [] };
  }

  function update(userId: number, next: UserState): void {
    save({ ...current(), users: { ...current().users, [String(userId)]: next } });
  }

  function save(nextState: ReadState): void {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(nextState)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    state = nextState;
  }

  function appended(existing: readonly string[], ids: readonly string[]): string[] {
    const merged = new Set(existing);
    for (const id of ids) {
      merged.delete(id);
      merged.add(id);
    }
    return [...merged].slice(-MAX_READ_IDS);
  }

  return {
    readIds: (userId) => new Set(userState(userId).read),
    markRead: (userId, ids, known) => {
      const user = userState(userId);
      const read = appended(
        user.read,
        ids.filter((id) => known.has(id)),
      );
      update(userId, { ...user, read });
    },
    emailOf: (userId) => userState(userId).email,
    setEmail: (reader, email, alreadyThere, now) => {
      const {
        email: _email,
        since: _since,
        mailed: _mailed,
        pending: _pending,
        ...user
      } = userState(reader.id);
      const stamp = now.toISOString();
      const next: UserState = { ...user, login: reader.login, lastSeen: stamp };
      if (email !== undefined) {
        next.email = email;
        next.since = stamp;
        next.mailed = appended([], alreadyThere);
      }
      update(reader.id, next);
    },
    seen: (reader, now) => {
      const user = userState(reader.id);
      if (user.email === undefined) return;
      const last = user.lastSeen === undefined ? 0 : Date.parse(user.lastSeen);
      if (now.getTime() - last < SEEN_WRITE_GAP_MS && user.login === reader.login) return;
      update(reader.id, { ...user, login: reader.login, lastSeen: now.toISOString() });
    },
    subscribers: () => {
      const found: MailSubscriber[] = [];
      for (const [userId, user] of Object.entries(current().users)) {
        if (user.email === undefined || user.login === undefined) continue;
        if (user.since === undefined) continue;
        found.push({
          id: Number(userId),
          login: user.login,
          email: user.email,
          since: user.since,
          lastSeen: user.lastSeen ?? user.since,
        });
      }
      return found;
    },
    mailedIds: (userId) => new Set(userState(userId).mailed ?? []),
    markMailed: (userId, ids) => {
      const user = userState(userId);
      update(userId, { ...user, mailed: appended(user.mailed ?? [], ids) });
    },
    pendingOf: (userId, now) => {
      const pending = userState(userId).pending;
      if (pending === undefined) return undefined;
      if (now.getTime() - Date.parse(pending.sentAt) > rules.validMs) return undefined;
      return { email: pending.email, sentAt: pending.sentAt };
    },
    lastConfirmationAt: (userId) => userState(userId).confirmationsSent?.at(-1),
    recipientConfirmationsSince: (recipientKey, since) => {
      const cutoff = since.toISOString();
      const stamps = current().recipients?.[recipientKey] ?? [];
      return stamps.filter((stamp) => stamp >= cutoff).length;
    },
    reserveConfirmation: (reader, recipientKey, now) => {
      const snapshot = current();
      const user = userState(reader.id);
      const stamp = now.toISOString();
      const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
      const recent = (stamps: readonly string[] | undefined) =>
        (stamps ?? []).filter((at) => at >= dayAgo);
      const recipients: Record<string, string[]> = {};
      for (const [key, stamps] of Object.entries(snapshot.recipients ?? {})) {
        const kept = recent(stamps);
        if (kept.length > 0) recipients[key] = kept;
      }
      recipients[recipientKey] = [...(recipients[recipientKey] ?? []), stamp];
      const sent = [...recent(user.confirmationsSent), stamp];
      save({
        ...snapshot,
        recipients,
        users: { ...snapshot.users, [String(reader.id)]: { ...user, confirmationsSent: sent } },
      });
    },
    confirmationsSince: (userId, since) => {
      const users = userId === undefined ? Object.values(current().users) : [userState(userId)];
      const cutoff = since.toISOString();
      let count = 0;
      for (const user of users) {
        count += (user.confirmationsSent ?? []).filter((stamp) => stamp >= cutoff).length;
      }
      return count;
    },
    startConfirmation: (reader, email, codeHash, now) => {
      const user = userState(reader.id);
      const stamp = now.toISOString();
      update(reader.id, {
        ...user,
        login: reader.login,
        lastSeen: stamp,
        pending: { email, codeHash, sentAt: stamp, attempts: 0 },
      });
    },
    cancelConfirmation: (userId) => {
      const { pending, ...user } = userState(userId);
      if (pending !== undefined) update(userId, user);
    },
    confirm: (reader, codeHash, alreadyThere, now) => {
      const user = userState(reader.id);
      const pending = user.pending;
      if (pending === undefined) return 'none';
      const { pending: _dropped, ...rest } = user;
      if (now.getTime() - Date.parse(pending.sentAt) > rules.validMs) {
        update(reader.id, rest);
        return 'expired';
      }
      if (!sameHash(pending.codeHash, codeHash)) {
        const attempts = pending.attempts + 1;
        if (attempts >= rules.maxAttempts) {
          update(reader.id, rest);
          return 'locked';
        }
        update(reader.id, { ...user, pending: { ...pending, attempts } });
        return 'wrong';
      }
      const stamp = now.toISOString();
      update(reader.id, {
        ...rest,
        login: reader.login,
        lastSeen: stamp,
        email: pending.email,
        since: stamp,
        mailed: appended([], alreadyThere),
      });
      return 'confirmed';
    },
  };
}

export function authorIdForReader(reader: MentionReader): string {
  return `github-${reader.id}`;
}

export function mentionsFor(reader: MentionReader, all: readonly Mention[]): Mention[] {
  const login = reader.login.toLowerCase();
  const self = authorIdForReader(reader);
  const seen = new Set<string>();
  const mine: Mention[] = [];
  for (const mention of all) {
    if (!mention.logins.includes(login) || mention.author.id === self) continue;
    if (seen.has(mention.id)) continue;
    seen.add(mention.id);
    mine.push(mention);
  }
  return mine.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export interface Inbox {
  login: string;
  unread: number;
  mentions: InboxMention[];
}

export const MAX_INBOX_ITEMS = 100;

export function buildInbox(
  reader: MentionReader,
  all: readonly Mention[],
  read: ReadonlySet<string>,
): Inbox {
  const mine = mentionsFor(reader, all);
  const items: InboxMention[] = mine.map((mention) => ({
    id: mention.id,
    kind: mention.kind ?? 'comment',
    path: mention.path,
    docName: mention.docName,
    threadId: mention.threadId,
    commentId: mention.commentId,
    author: mention.author,
    at: mention.at,
    body: mention.body,
    quote: mention.quote,
    resolved: mention.resolved,
    read: read.has(mention.id) || mention.quiet === true,
  }));
  return {
    login: reader.login,
    unread: items.filter((item) => !item.read).length,
    mentions: items.slice(0, MAX_INBOX_ITEMS),
  };
}
