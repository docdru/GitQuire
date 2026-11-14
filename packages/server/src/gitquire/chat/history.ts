import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ChatProvider } from './models.ts';

export const CHAT_RETENTION_DAYS = 90;
export const MAX_CHATS_LISTED = 200;
const CHAT_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  isError: boolean;
}

export type ChatMessage =
  | { role: 'user'; text: string; page?: string; at: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; at: string }
  | { role: 'tool'; results: ToolResult[]; at: string };

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatRecord {
  id: string;
  title: string;
  provider: ChatProvider;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  usage: ChatUsage;
}

export interface ChatSummary {
  id: string;
  title: string;
  provider: ChatProvider;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export function isChatId(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ID_RE.test(value);
}

export function newChatId(): string {
  return randomBytes(12).toString('base64url');
}

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return 'New chat';
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

export function chatsDir(projectDir: string): string {
  return join(projectDir, '.ok', 'local', 'gitquire', 'chats');
}

export interface ChatHistoryStore {
  list(userId: number): ChatSummary[];
  get(userId: number, chatId: string): ChatRecord | undefined;
  save(userId: number, chat: ChatRecord): void;
  remove(userId: number, chatId: string): boolean;
  purgeExpired(now?: Date): number;
}

function userDir(projectDir: string, userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error(`invalid GitHub user id: ${userId}`);
  }
  return join(chatsDir(projectDir), String(userId));
}

function readChat(file: string): ChatRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ChatRecord;
    if (!isChatId(parsed.id) || !Array.isArray(parsed.messages)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function createChatHistoryStore(
  projectDir: string,
  retentionDays: number = CHAT_RETENTION_DAYS,
): ChatHistoryStore {
  function fileFor(userId: number, chatId: string): string {
    if (!isChatId(chatId)) throw new Error('invalid chat id');
    return join(userDir(projectDir, userId), `${chatId}.json`);
  }

  return {
    list(userId) {
      const dir = userDir(projectDir, userId);
      if (!existsSync(dir)) return [];
      const summaries: ChatSummary[] = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const chat = readChat(join(dir, name));
        if (chat === undefined) continue;
        summaries.push({
          id: chat.id,
          title: chat.title,
          provider: chat.provider,
          model: chat.model,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
        });
      }
      summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return summaries.slice(0, MAX_CHATS_LISTED);
    },
    get(userId, chatId) {
      if (!isChatId(chatId)) return undefined;
      const file = fileFor(userId, chatId);
      return existsSync(file) ? readChat(file) : undefined;
    },
    save(userId, chat) {
      const file = fileFor(userId, chat.id);
      mkdirSync(userDir(projectDir, userId), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(chat), { mode: 0o600 });
      renameSync(temporary, file);
    },
    remove(userId, chatId) {
      if (!isChatId(chatId)) return false;
      const file = fileFor(userId, chatId);
      if (!existsSync(file)) return false;
      rmSync(file, { force: true });
      return true;
    },
    purgeExpired(now = new Date()) {
      const root = chatsDir(projectDir);
      if (!existsSync(root)) return 0;
      const cutoff = now.getTime() - retentionDays * DAY_MS;
      let removed = 0;
      for (const user of readdirSync(root)) {
        const dir = join(root, user);
        let entries: string[];
        try {
          if (!statSync(dir).isDirectory()) continue;
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          const file = join(dir, name);
          if (name.endsWith('.tmp')) {
            rmSync(file, { force: true });
            continue;
          }
          if (!name.endsWith('.json')) continue;
          const chat = readChat(file);
          const updated = chat === undefined ? Number.NaN : Date.parse(chat.updatedAt);
          const last = Number.isNaN(updated) ? statSync(file).mtimeMs : updated;
          if (last < cutoff) {
            rmSync(file, { force: true });
            removed += 1;
          }
        }
      }
      return removed;
    },
  };
}
