import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '../access-gate.ts';
import { runGitSync } from '../repo-bootstrap.ts';
import { plainGitRemote } from './remote.ts';
import { createDraftService, DraftError, type DraftService } from './service.ts';
import { createDraftStore } from './store.ts';
import { createTestRepos, fakeInstances, git, type TestRepos } from './test-repo.test-helper.ts';

const ALICE: SessionUser = { id: 42, login: 'alice', name: 'Alice A', avatarUrl: '' };
const BOB: SessionUser = { id: 43, login: 'bob', name: 'Bob B', avatarUrl: '' };
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const START = '# Hello\n\nFirst paragraph.\n\nSecond paragraph.\n';

let repos: TestRepos;
let instances: ReturnType<typeof fakeInstances>;
let service: DraftService;

beforeEach(() => {
  repos = createTestRepos({ 'hello.md': START });
  instances = fakeInstances(repos);
  service = createDraftService({
    projectDir: repos.live,
    store: createDraftStore(join(repos.root, 'drafts.json')),
    instances,
    remote: plainGitRemote(repos.live, runGitSync, () => ({})),
    runGit: runGitSync,
    authEnv: () => ({}),
    baseBranch: async () => 'main',
    log: silentLog,
  });
});

afterEach(() => repos.cleanup());

function originFile(ref: string, path: string): string {
  return git(['show', `${ref}:${path}`], repos.origin);
}

function branches(): string[] {
  return git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repos.origin)
    .split('\n')
    .filter((line) => line !== '');
}

async function draftWith(title: string, edits: Record<string, string>) {
  const draft = await service.create(ALICE, title);
  await instances.ensure(draft);
  for (const [path, content] of Object.entries(edits)) {
    writeFileSync(join(instances.dir(draft.slug), path), content);
  }
  return draft;
}

describe('drafts', () => {
  it('creates a draft branch from the live wiki', async () => {
    const draft = await service.create(ALICE, 'Kick-off notes');
    expect(draft).toMatchObject({
      slug: 'kick-off-notes',
      branch: 'draft/kick-off-notes',
      status: 'draft',
    });
    expect(branches()).toContain('draft/kick-off-notes');
    const again = await service.create(ALICE, 'Kick-off notes');
    expect(again.slug).toBe('kick-off-notes-2');
  });

  it('lists what a draft changes, with the text before and after', async () => {
    const draft = await draftWith('Intro', {
      'hello.md': '# Hello\n\nFirst paragraph, better.\n\nSecond paragraph.\n',
      'agenda.md': '# Agenda\n',
    });
    const changes = service.changes(draft.slug);
    expect(changes.map((page) => [page.path, page.change])).toEqual([
      ['agenda.md', 'added'],
      ['hello.md', 'modified'],
    ]);
    expect(changes[1]).toMatchObject({ before: START });
    expect(service.summary(service.requireOpen(draft.slug)).pages).toHaveLength(2);
  });

  it('refuses review without changes, then asks the mentioned people', async () => {
    const empty = await service.create(ALICE, 'Empty');
    await expect(service.markReady(empty.slug, ALICE, [], '')).rejects.toMatchObject({
      code: 'no-changes',
    });

    const draft = await draftWith('Intro', { 'hello.md': '# Hello\n\nNew.\n' });
    const ready = await service.markReady(
      draft.slug,
      ALICE,
      ['Bob', 'alice', 'bob'],
      'Please look',
    );
    expect(ready.status).toBe('review');
    expect(ready.requests[0]).toMatchObject({ logins: ['bob'], note: 'Please look' });
    expect(originFile('draft/intro', 'hello.md')).toBe('# Hello\n\nNew.\n');
    const mentions = service.reviewMentions();
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      logins: ['bob'],
      draft: { slug: 'intro', title: 'Intro' },
      author: { id: 'github-42', login: 'alice' },
    });

    const reviewed = service.review(draft.slug, BOB, 'approved', 'Good');
    expect(reviewed.reviews).toEqual([
      expect.objectContaining({ login: 'bob', verdict: 'approved' }),
    ]);
    expect(service.markDraft(draft.slug).status).toBe('draft');
    expect(service.reviewMentions()).toEqual([]);
  });

  it('publishes a draft into the live branch and closes it', async () => {
    const draft = await draftWith('Intro', { 'hello.md': '# Hello\n\nPublished text.\n' });
    const published = await service.publish(draft.slug, BOB);
    expect(published).toMatchObject({ status: 'published', closedBy: { login: 'bob' } });
    expect(originFile('main', 'hello.md')).toBe('# Hello\n\nPublished text.\n');
    expect(branches()).not.toContain('draft/intro');
    expect(existsSync(instances.dir('intro'))).toBe(false);
    const author = git(['log', '-1', '--format=%an <%ae>', 'main'], repos.origin).trim();
    expect(author).toBe('Bob B <43+bob@users.noreply.github.com>');
    await expect(service.publish(draft.slug, BOB)).rejects.toMatchObject({ code: 'draft-closed' });
  });

  it('refuses to publish over conflicting live changes, and updating shows the conflict', async () => {
    const draft = await draftWith('Intro', {
      'hello.md': '# Hello\n\nFirst paragraph, DRAFT.\n\nSecond paragraph.\n',
    });
    repos.pushFromElsewhere(
      'hello.md',
      '# Hello\n\nFirst paragraph, LIVE.\n\nSecond paragraph.\n\nThird.\n',
    );

    await expect(service.publish(draft.slug, ALICE)).rejects.toBeInstanceOf(DraftError);
    expect(service.drift(draft.slug)).toEqual({ behind: 1, pages: ['hello.md'] });

    const result = await service.update(draft.slug, ALICE);
    expect(result.kind).toBe('conflicts');
    if (result.kind !== 'conflicts') return;
    expect(result.files[0]?.chunks).toEqual([
      { kind: 'same', text: '# Hello\n\n' },
      {
        kind: 'conflict',
        draft: 'First paragraph, DRAFT.\n',
        base: 'First paragraph.\n',
        live: 'First paragraph, LIVE.\n',
      },
      { kind: 'same', text: '\nSecond paragraph.\n\nThird.\n' },
    ]);

    const resolved = '# Hello\n\nFirst paragraph, DRAFT.\n\nSecond paragraph.\n\nThird.\n';
    expect(await service.update(draft.slug, ALICE, { 'hello.md': resolved })).toEqual({
      kind: 'updated',
    });
    expect(originFile('draft/intro', 'hello.md')).toBe(resolved);
    expect(service.drift(draft.slug)).toEqual({ behind: 0, pages: [] });
    await service.publish(draft.slug, ALICE);
    expect(originFile('main', 'hello.md')).toBe(resolved);
  });

  it('merges live changes in other places without asking', async () => {
    const draft = await draftWith('Intro', {
      'hello.md': '# Hello\n\nFirst paragraph, DRAFT.\n\nSecond paragraph.\n',
    });
    repos.pushFromElsewhere('other.md', '# Other\n');
    expect(await service.update(draft.slug, ALICE)).toEqual({ kind: 'updated' });
    expect(await service.update(draft.slug, ALICE)).toEqual({ kind: 'up-to-date' });
    expect(service.changes(draft.slug).map((page) => page.path)).toEqual(['hello.md']);
  });

  it('discards a draft and deletes its branch', async () => {
    const draft = await draftWith('Throwaway', { 'hello.md': 'gone\n' });
    const discarded = await service.discard(draft.slug, ALICE);
    expect(discarded.status).toBe('discarded');
    expect(branches()).not.toContain('draft/throwaway');
    expect(originFile('main', 'hello.md')).toBe(START);
  });

  it('moves my unsaved live edits into a new draft and restores the live page', async () => {
    writeFileSync(join(repos.live, 'hello.md'), '# Hello\n\nMy rewrite.\n');
    const draft = await service.moveRecentEdits(ALICE, 'hello.md', 'My rewrite');
    expect(originFile(draft.branch, 'hello.md')).toBe('# Hello\n\nMy rewrite.\n');
    expect(readFileSync(join(repos.live, 'hello.md'), 'utf8')).toBe(START);
  });

  it('moves my recent commits but not someone else’s', async () => {
    repos.commitLive(
      'hello.md',
      '# Hello\n\nAlice was here.\n',
      '42+alice@users.noreply.github.com',
    );
    const draft = await service.moveRecentEdits(ALICE, 'hello.md', 'Alice edits');
    expect(originFile(draft.branch, 'hello.md')).toBe('# Hello\n\nAlice was here.\n');
    expect(readFileSync(join(repos.live, 'hello.md'), 'utf8')).toBe(START);

    repos.commitLive('hello.md', '# Hello\n\nBob was here.\n', '43+bob@users.noreply.github.com');
    await expect(service.moveRecentEdits(ALICE, 'hello.md', 'Nope')).rejects.toMatchObject({
      code: 'no-recent-edits',
    });
  });

  it('gives each person one standing draft for their AI assistant', async () => {
    const first = await service.agentDraft(ALICE);
    expect(first).toMatchObject({ agentFor: 42, title: "Claude's changes for Alice A" });
    expect((await service.agentDraft(ALICE)).slug).toBe(first.slug);
    expect((await service.agentDraft(BOB)).slug).not.toBe(first.slug);
    service.setAgentMode(42, 'draft');
    expect(service.agentMode(42)).toBe('draft');
    expect(service.agentMode(43)).toBe('live');
  });

  it('closes drafts whose branch was deleted elsewhere', async () => {
    const draft = await service.create(ALICE, 'Gone');
    git(['branch', '-D', draft.branch], repos.origin);
    await service.followRemote();
    expect(service.get(draft.slug)?.status).toBe('discarded');
  });
});
