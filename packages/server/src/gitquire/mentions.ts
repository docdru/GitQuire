import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type CommentAuthor,
  readCommentThreads,
} from '@inkeep/open-knowledge-core/gitquire/comment-threads';

const MAX_FILES = 5000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 280;
const MAX_QUOTE_CHARS = 140;
const MAX_DIRECTORIES = 5000;
const MAX_READ_IDS = 5000;
const SCAN_REUSE_MS = 5000;
const SEEN_WRITE_GAP_MS = 24 * 60 * 60 * 1000;
const DOC_EXTENSIONS = ['.mdx', '.md'] as const;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'venv',
  'env',
  '__pycache__',
  'vendor',
  'dist',
  'build',
  'out',
  'output',
  'coverage',
]);

export interface Mention {
  id: string;
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

export interface InboxMention extends Omit<Mention, 'logins'> {
  read: boolean;
}

export interface MentionReader {
  id: number;
  login: string;
}

export function docNameForPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  const extension = DOC_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  return extension === undefined ? undefined : path.slice(0, -extension.length);
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

interface CachedFile {
  mtimeMs: number;
  size: number;
  mentions: Mention[];
}

export interface MentionIndex {
  all: () => Mention[];
}

function markdownFiles(root: string): string[] {
  const files: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && files.length < MAX_FILES && visited < MAX_DIRECTORIES) {
    const next = queue.shift();
    if (next === undefined) break;
    visited += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, next.dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = next.dir === '' ? entry.name : `${next.dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (next.depth < MAX_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
          queue.push({ dir: relative, depth: next.depth + 1 });
        }
      } else if (entry.isFile() && docNameForPath(entry.name) !== undefined) {
        files.push(relative);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

export function createMentionIndex(projectDir: string, now: () => number = Date.now): MentionIndex {
  const cache = new Map<string, CachedFile>();
  let lastScan: { at: number; mentions: Mention[] } | undefined;

  function read(path: string): Mention[] {
    const full = join(projectDir, path);
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(full);
    } catch {
      cache.delete(path);
      return [];
    }
    const cached = cache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.mentions;
    }
    let mentions: Mention[] = [];
    if (stat.size <= MAX_FILE_BYTES) {
      try {
        mentions = mentionsInMarkdown(path, readFileSync(full, 'utf8'));
      } catch {
        mentions = [];
      }
    }
    cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, mentions });
    return mentions;
  }

  function all(): Mention[] {
    const at = now();
    if (lastScan !== undefined && at - lastScan.at < SCAN_REUSE_MS && at >= lastScan.at) {
      return lastScan.mentions;
    }
    const paths = markdownFiles(projectDir);
    const live = new Set(paths);
    for (const path of cache.keys()) {
      if (!live.has(path)) cache.delete(path);
    }
    const mentions = paths.flatMap(read);
    lastScan = { at, mentions };
    return mentions;
  }

  return { all };
}

interface UserState {
  read: string[];
  login?: string;
  email?: string;
  since?: string;
  lastSeen?: string;
  mailed?: string[];
}

interface ReadState {
  version: 1;
  users: Record<string, UserState>;
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
    return state;
  } catch {
    return state;
  }
}

export function createMentionReadStore(file: string): MentionReadStore {
  let state: ReadState | undefined;

  function current(): ReadState {
    state ??= loadState(file);
    return state;
  }

  function userState(userId: number): UserState {
    return current().users[String(userId)] ?? { read: [] };
  }

  function update(userId: number, next: UserState): void {
    const nextState: ReadState = {
      version: 1,
      users: { ...current().users, [String(userId)]: next },
    };
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
      const user = userState(reader.id);
      const stamp = now.toISOString();
      const next: UserState = { read: user.read, login: reader.login, lastSeen: stamp };
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
    path: mention.path,
    docName: mention.docName,
    threadId: mention.threadId,
    commentId: mention.commentId,
    author: mention.author,
    at: mention.at,
    body: mention.body,
    quote: mention.quote,
    resolved: mention.resolved,
    read: read.has(mention.id),
  }));
  return {
    login: reader.login,
    unread: items.filter((item) => !item.read).length,
    mentions: items.slice(0, MAX_INBOX_ITEMS),
  };
}
