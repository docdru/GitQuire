import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type ActionItemPage,
  BASELINE_AT,
  combinedMentionIndex,
  createActionItemMentions,
} from './action-item-mentions.ts';
import { buildInbox, mentionsFor } from './mentions.ts';
import { pageFacts } from './page-objects.ts';

let dir: string;
let stateFile: string;

function page(path: string, markdown: string): ActionItemPage {
  return { path, facts: pageFacts(path, markdown) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gq-action-mentions-'));
  stateFile = join(dir, 'state.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createActionItemMentions', () => {
  test('existing open items are quiet on the first run, new ones are not', () => {
    let pages = [page('plan.md', '# Plan\n\n- [ ] Send numbers @alice\n- [x] Done @alice\n')];
    let clock = Date.parse('2026-11-13T10:00:00Z');
    const index = createActionItemMentions({
      stateFile,
      pages: () => pages,
      now: () => clock,
      writerOf: () => ({ id: 'github-7', login: 'bob', name: 'Bob' }),
    });

    const first = index.all();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'task',
      docName: 'plan',
      body: 'Send numbers @alice',
      quote: 'Plan',
      logins: ['alice'],
      at: BASELINE_AT,
      quiet: true,
    });

    clock += 60_000;
    pages = [
      page('plan.md', '# Plan\n\n- [ ] Send numbers @alice\n- [ ] Book room @Alice @carol\n'),
    ];
    const second = index.all();
    const added = second.find((mention) => mention.body.startsWith('Book room'));
    expect(added).toMatchObject({
      at: '2026-11-13T10:01:00.000Z',
      author: { id: 'github-7', login: 'bob', name: 'Bob' },
      logins: ['alice', 'carol'],
    });
    expect(added?.quiet).toBeUndefined();
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).seen).toBeDefined();
  });

  test('keeps first-seen times across restarts and forgets removed items', () => {
    const pages = [page('a.md', '- [ ] One @alice\n')];
    createActionItemMentions({ stateFile, pages: () => pages }).all();
    const again = createActionItemMentions({
      stateFile,
      pages: () => [...pages, page('b.md', '- [ ] Two @alice\n')],
      now: () => Date.parse('2026-11-13T12:00:00Z'),
    });
    const all = again.all();
    expect(all.find((m) => m.docName === 'a')?.at).toBe(BASELINE_AT);
    expect(all.find((m) => m.docName === 'b')?.at).toBe('2026-11-13T12:00:00.000Z');

    const empty = createActionItemMentions({ stateFile, pages: () => [] });
    expect(empty.all()).toEqual([]);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).seen).toEqual({});
  });

  test('the inbox marks quiet items read and leaves out the author', () => {
    let pages = [page('a.md', '- [ ] Old @alice\n')];
    const index = createActionItemMentions({
      stateFile,
      pages: () => pages,
      now: () => Date.parse('2026-11-13T12:00:00Z'),
      writerOf: () => ({ id: 'github-1', login: 'alice' }),
    });
    index.all();
    pages = [page('a.md', '- [ ] Old @alice\n- [ ] Mine @alice\n- [ ] Theirs @bob\n')];
    const alice = { id: 1, login: 'alice' };
    const all = combinedMentionIndex(index).all();
    expect(mentionsFor(alice, all).map((m) => m.body)).toEqual(['Old @alice']);
    const inbox = buildInbox(alice, all, new Set());
    expect(inbox.unread).toBe(0);
    expect(inbox.mentions[0]).toMatchObject({ kind: 'task', read: true });
    expect(mentionsFor({ id: 2, login: 'bob' }, all).map((m) => m.body)).toEqual([
      'Theirs @bob',
    ]);
  });
});
