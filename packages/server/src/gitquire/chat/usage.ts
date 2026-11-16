import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CHAT_RETENTION_DAYS, isChatId } from './history.ts';
import type { ChatProvider } from './models.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface UsageEntry {
  day: string;
  chatId: string;
  title: string;
  provider: ChatProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface UsageFile {
  version: 1;
  entries: UsageEntry[];
}

interface UsageDay {
  day: string;
  inputTokens: number;
  outputTokens: number;
}

interface UsageChat {
  chatId: string;
  title: string;
  provider: ChatProvider;
  model: string;
  lastDay: string;
  inputTokens: number;
  outputTokens: number;
}

interface UsageReport {
  retentionDays: number;
  total: { inputTokens: number; outputTokens: number };
  days: UsageDay[];
  chats: UsageChat[];
}

export interface ChatUsageStore {
  add(userId: number, entry: UsageEntry): void;
  report(userId: number, now?: Date): UsageReport;
  purgeExpired(now?: Date): number;
}

function usageDir(projectDir: string): string {
  return join(projectDir, '.gitquire', 'local', 'gitquire', 'chat-usage');
}

function fileFor(projectDir: string, userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error(`invalid GitHub user id: ${userId}`);
  }
  return join(usageDir(projectDir), `${userId}.json`);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function readEntries(file: string): UsageEntry[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<UsageFile>;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (entry): entry is UsageEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        DAY_RE.test(String(entry.day)) &&
        isChatId(entry.chatId),
    );
  } catch {
    return [];
  }
}

function writeEntries(file: string, entries: readonly UsageEntry[]): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({ version: 1, entries: [...entries] } satisfies UsageFile),
    {
      mode: 0o600,
    },
  );
  renameSync(temporary, file);
}

function cutoffDay(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * DAY_MS).toISOString().slice(0, 10);
}

export function createChatUsageStore(
  projectDir: string,
  retentionDays: number = CHAT_RETENTION_DAYS,
): ChatUsageStore {
  return {
    add(userId, entry) {
      const input = count(entry.inputTokens);
      const output = count(entry.outputTokens);
      if (input === 0 && output === 0) return;
      const file = fileFor(projectDir, userId);
      const entries = readEntries(file);
      const same = entries.find(
        (existing) =>
          existing.day === entry.day &&
          existing.chatId === entry.chatId &&
          existing.provider === entry.provider &&
          existing.model === entry.model,
      );
      if (same === undefined) {
        entries.push({ ...entry, inputTokens: input, outputTokens: output });
      } else {
        same.inputTokens += input;
        same.outputTokens += output;
        same.title = entry.title;
      }
      writeEntries(file, entries);
    },
    report(userId, now = new Date()) {
      const cutoff = cutoffDay(now, retentionDays);
      const entries = readEntries(fileFor(projectDir, userId)).filter((e) => e.day >= cutoff);
      const days = new Map<string, UsageDay>();
      const chats = new Map<string, UsageChat>();
      const total = { inputTokens: 0, outputTokens: 0 };
      for (const entry of entries) {
        total.inputTokens += entry.inputTokens;
        total.outputTokens += entry.outputTokens;
        const day = days.get(entry.day) ?? { day: entry.day, inputTokens: 0, outputTokens: 0 };
        day.inputTokens += entry.inputTokens;
        day.outputTokens += entry.outputTokens;
        days.set(entry.day, day);
        const chat = chats.get(entry.chatId) ?? {
          chatId: entry.chatId,
          title: entry.title,
          provider: entry.provider,
          model: entry.model,
          lastDay: entry.day,
          inputTokens: 0,
          outputTokens: 0,
        };
        chat.inputTokens += entry.inputTokens;
        chat.outputTokens += entry.outputTokens;
        if (entry.day >= chat.lastDay) {
          chat.lastDay = entry.day;
          chat.title = entry.title;
          chat.provider = entry.provider;
          chat.model = entry.model;
        }
        chats.set(entry.chatId, chat);
      }
      return {
        retentionDays,
        total,
        days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
        chats: [...chats.values()].sort(
          (a, b) =>
            b.lastDay.localeCompare(a.lastDay) ||
            b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
        ),
      };
    },
    purgeExpired(now = new Date()) {
      const dir = usageDir(projectDir);
      if (!existsSync(dir)) return 0;
      const cutoff = cutoffDay(now, retentionDays);
      let removed = 0;
      for (const name of readdirSync(dir)) {
        if (!/^\d+\.json$/.test(name)) continue;
        const file = join(dir, name);
        const entries = readEntries(file);
        const kept = entries.filter((entry) => entry.day >= cutoff);
        if (kept.length === entries.length) continue;
        removed += entries.length - kept.length;
        writeEntries(file, kept);
      }
      return removed;
    },
  };
}
