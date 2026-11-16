import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatUsageStore } from './usage.ts';

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const chatA = 'aaaaaaaaaaaaaaaa';
const chatB = 'bbbbbbbbbbbbbbbb';

function entry(day: string, chatId: string, input: number, output: number, title = 'Plan') {
  return {
    day,
    chatId,
    title,
    provider: 'claude' as const,
    model: 'claude-sonnet-5-5',
    inputTokens: input,
    outputTokens: output,
  };
}

describe('token usage per person', () => {
  it('adds up per day and per chat, newest first, and keeps people apart', () => {
    dir = mkdtempSync(join(tmpdir(), 'gq-usage-'));
    const store = createChatUsageStore(dir);
    store.add(1, entry('2026-11-14', chatA, 100, 10));
    store.add(1, entry('2026-11-14', chatA, 50, 5, 'Plan renamed'));
    store.add(1, entry('2026-11-15', chatA, 20, 2, 'Plan renamed'));
    store.add(1, entry('2026-11-15', chatB, 7, 1, 'Other'));
    store.add(2, entry('2026-11-15', chatB, 999, 999));
    store.add(1, entry('2026-11-15', chatB, 0, 0));
    const report = store.report(1, new Date('2026-11-16T00:00:00Z'));
    expect(report.total).toEqual({ inputTokens: 177, outputTokens: 18 });
    expect(report.days).toEqual([
      { day: '2026-11-15', inputTokens: 27, outputTokens: 3 },
      { day: '2026-11-14', inputTokens: 150, outputTokens: 15 },
    ]);
    expect(report.chats.map((chat) => [chat.chatId, chat.title, chat.inputTokens])).toEqual([
      [chatA, 'Plan renamed', 170],
      [chatB, 'Other', 7],
    ]);
  });

  it('forgets days older than the retention period', () => {
    dir = mkdtempSync(join(tmpdir(), 'gq-usage-'));
    const store = createChatUsageStore(dir, 90);
    store.add(1, entry('2026-08-01', chatA, 100, 10));
    store.add(1, entry('2026-11-01', chatA, 1, 1));
    const now = new Date('2026-11-16T00:00:00Z');
    expect(store.report(1, now).total).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(store.purgeExpired(now)).toBe(1);
    expect(store.purgeExpired(now)).toBe(0);
  });

  it('ignores negative or broken counts', () => {
    dir = mkdtempSync(join(tmpdir(), 'gq-usage-'));
    const store = createChatUsageStore(dir);
    store.add(1, entry('2026-11-14', chatA, -5, Number.NaN));
    expect(store.report(1, new Date('2026-11-15T00:00:00Z')).days).toEqual([]);
  });
});
