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
const MAX_READ_IDS = 2000;
const SKIPPED_DIRECTORIES = new Set(['node_modules']);

export interface Mention {
  id: string;
  path: string;
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

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function mentionsInMarkdown(path: string, markdown: string): Mention[] {
  const found: Mention[] = [];
  for (const thread of readCommentThreads(markdown)) {
    for (const comment of thread.comments) {
      const logins = (comment.mentions ?? []).map((login) => login.toLowerCase());
      if (logins.length === 0) continue;
      found.push({
        id: `${thread.id}:${comment.id}`,
        path,
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
  while (queue.length > 0 && files.length < MAX_FILES) {
    const next = queue.shift();
    if (next === undefined) break;
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
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(relative);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

export function createMentionIndex(projectDir: string): MentionIndex {
  const cache = new Map<string, CachedFile>();

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
    const paths = markdownFiles(projectDir);
    const live = new Set(paths);
    for (const path of cache.keys()) {
      if (!live.has(path)) cache.delete(path);
    }
    return paths.flatMap(read);
  }

  return { all };
}

interface ReadState {
  version: 1;
  users: Record<string, { read: string[] }>;
}

export interface MentionReadStore {
  readIds: (userId: number) => Set<string>;
  markRead: (userId: number, ids: readonly string[], known: ReadonlySet<string>) => void;
}

export function mentionStatePath(projectDir: string): string {
  return join(projectDir, '.ok', 'local', 'gitquire', 'mentions.json');
}

function loadState(file: string): ReadState {
  const empty: ReadState = { version: 1, users: {} };
  if (!existsSync(file)) return empty;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const users = (parsed as { users?: unknown }).users;
    if (typeof users !== 'object' || users === null) return empty;
    for (const [userId, entry] of Object.entries(users as Record<string, unknown>)) {
      const read = (entry as { read?: unknown } | null)?.read;
      if (!Array.isArray(read)) continue;
      empty.users[userId] = { read: read.filter((id): id is string => typeof id === 'string') };
    }
    return empty;
  } catch {
    return empty;
  }
}

export function createMentionReadStore(file: string): MentionReadStore {
  let state: ReadState | undefined;

  function current(): ReadState {
    state ??= loadState(file);
    return state;
  }

  function save(next: ReadState): void {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  return {
    readIds: (userId) => new Set(current().users[String(userId)]?.read ?? []),
    markRead: (userId, ids, known) => {
      const snapshot = current();
      const merged = new Set(snapshot.users[String(userId)]?.read ?? []);
      for (const id of ids) {
        if (known.has(id)) merged.add(id);
      }
      const kept = [...merged].filter((id) => known.has(id)).slice(-MAX_READ_IDS);
      snapshot.users[String(userId)] = { read: kept };
      save(snapshot);
    },
  };
}

export function authorIdForReader(reader: MentionReader): string {
  return `github-${reader.id}`;
}

export function mentionsFor(reader: MentionReader, all: readonly Mention[]): Mention[] {
  const login = reader.login.toLowerCase();
  const self = authorIdForReader(reader);
  return all
    .filter((mention) => mention.logins.includes(login) && mention.author.id !== self)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
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
