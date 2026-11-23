import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeCommentTimes,
  writeCommentThreads,
} from '@gitquire/core/gitquire/comment-threads';
import { afterEach, describe, expect, it } from 'vitest';
import { actionItemStatePath, createActionItemMentions } from '../action-item-mentions.ts';
import {
  createMentionReadStore,
  mentionStatePath,
  mentionsFor,
  mentionsInMarkdown,
} from '../mentions.ts';
import { pageFacts } from '../page-objects.ts';
import { createMentionCounts } from './mention-counts.ts';
import { type WikiRecord, wikiDir } from './wiki-table.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function wiki(id: number): WikiRecord {
  return {
    host: 'github',
    id,
    owner: 'team',
    ownerId: 7,
    name: `w${id}`,
    key: `github-${id}`,
    state: 'on',
    formerNames: [],
    addedBy: 'alice',
    addedAt: '2026-11-21T00:00:00.000Z',
  };
}

function commentPage(threadId: string, mentioned: string): string {
  const comment = normalizeCommentTimes({
    id: `${threadId}-1`,
    author: { id: 'github-12', login: 'bob' },
    createdAt: '2026-11-20T09:00:00.000Z',
    body: `Please look, @${mentioned}`,
    mentions: [mentioned],
  });
  return writeCommentThreads('The quarterly numbers look good.\n', [
    { id: threadId, anchor: { exact: 'quarterly numbers' }, resolved: false, comments: [comment] },
  ]);
}

const alice = { id: 11, login: 'alice' };
const dave = { id: 14, login: 'dave' };

describe('mention counts at the front door', () => {
  it("counts a person's unread comment and action-item mentions from each wiki's own files", () => {
    const data = mkdtempSync(join(tmpdir(), 'gq-counts-'));
    dirs.push(data);
    const one = wikiDir(data, wiki(1));
    const two = wikiDir(data, wiki(2));
    mkdirSync(join(one, 'notes'), { recursive: true });
    mkdirSync(two, { recursive: true });
    writeFileSync(join(one, 'notes', 'a.md'), commentPage('c-a', 'alice'));
    writeFileSync(join(one, 'notes', 'b.md'), commentPage('c-b', 'alice'));
    writeFileSync(join(two, 'c.md'), commentPage('c-c', 'dave'));
    let time = Date.UTC(2026, 10, 21);
    const counts = createMentionCounts(data, () => time);
    expect(counts.unread(alice, wiki(1))).toBe(2);
    expect(counts.unread(alice, wiki(2))).toBe(0);
    expect(counts.unread(dave, wiki(2))).toBe(1);
    expect(counts.unread(alice, wiki(3))).toBe(0);

    const markdown = readFileSync(join(one, 'notes', 'a.md'), 'utf8');
    const mine = mentionsFor(alice, mentionsInMarkdown('notes/a.md', markdown));
    const ids = mine.map((mention) => mention.id);
    createMentionReadStore(mentionStatePath(one)).markRead(alice.id, ids, new Set(ids));
    time += 10_000;
    expect(counts.unread(alice, wiki(1))).toBe(1);

    const plan = '# Plan\n\n- [ ] Old @alice\n';
    writeFileSync(join(one, 'plan.md'), plan);
    const pages = () => [
      { path: 'plan.md', facts: pageFacts('plan.md', readFileSync(join(one, 'plan.md'), 'utf8')) },
    ];
    const editor = createActionItemMentions({ stateFile: actionItemStatePath(one), pages });
    editor.all();
    time += 10_000;
    expect(counts.unread(alice, wiki(1))).toBe(1);
    writeFileSync(join(one, 'plan.md'), `${plan}- [ ] New @alice\n- [ ] Not yet seen @alice\n`);
    const seenOnce = createActionItemMentions({
      stateFile: actionItemStatePath(one),
      pages: () =>
        pages().map((page) => ({
          ...page,
          facts: { ...page.facts, tasks: page.facts.tasks.slice(0, 2) },
        })),
    });
    seenOnce.all();
    time += 10_000;
    expect(counts.unread(alice, wiki(1))).toBe(2);
  });
});
