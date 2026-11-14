import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathspecArgs } from '@inkeep/open-knowledge-core';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import { noreplyEmail } from '../access-gate.ts';
import type { Mention } from '../mentions.ts';
import type { RunGit } from '../repo-bootstrap.ts';
import {
  type ConflictChunk,
  changedPages,
  commitPending,
  commitsTouching,
  type FileConflict,
  fetchBranch,
  fileAt,
  type GitIdentity,
  headSha,
  mergeBase,
  pushBranch,
  workingFile,
} from './git-ops.ts';
import type { DraftInstances } from './instances.ts';
import {
  type ChangedPage,
  DRAFT_BRANCH_PREFIX,
  type DraftPerson,
  type DraftRecord,
  isOpen,
  isPagePath,
  uniqueSlug,
} from './model.ts';
import type { DraftRemote } from './remote.ts';
import type { AgentMode, DraftStore } from './store.ts';

type Env = Readonly<Record<string, string>>;

export class DraftError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface DraftServiceDeps {
  projectDir: string;
  store: DraftStore;
  instances: DraftInstances;
  remote: DraftRemote;
  runGit: RunGit;
  authEnv: () => Env;
  baseBranch: () => Promise<string>;
  log: GateLogger;
  now?: () => Date;
  onPublished?: () => void;
}

export interface DraftSummary {
  slug: string;
  title: string;
  status: DraftRecord['status'];
  author: DraftPerson;
  createdAt: string;
  updatedAt: string;
  base: string;
  pullUrl: string | null;
  reviews: DraftRecord['reviews'];
  requests: DraftRecord['requests'];
  pages: ChangedPage[];
  agent: boolean;
  closedAt: string | null;
  closedBy: DraftPerson | null;
}

export interface PageChange extends ChangedPage {
  before: string | null;
  after: string | null;
}

export interface LiveDrift {
  behind: number;
  pages: string[];
}

export type UpdateResult =
  | { kind: 'up-to-date' | 'updated' }
  | { kind: 'conflicts'; files: FileConflict[] };

export type { ConflictChunk, FileConflict };

const MAX_CHANGE_BYTES = 200_000;
const PAGES_CACHE_MS = 15_000;
const RETRO_WINDOW_MS = 12 * 60 * 60 * 1000;
const CLOSED_KEEP = 50;

export function personOf(user: SessionUser): DraftPerson {
  return { id: user.id, login: user.login, ...(user.name ? { name: user.name } : {}) };
}

export function identityOf(user: SessionUser): GitIdentity {
  return { name: user.name || user.login, email: noreplyEmail(user) };
}

function clipText(text: string | null): string | null {
  if (text === null) return null;
  return text.length > MAX_CHANGE_BYTES ? `${text.slice(0, MAX_CHANGE_BYTES)}\n…` : text;
}

export interface DraftService {
  list: () => DraftSummary[];
  summary: (draft: DraftRecord) => DraftSummary;
  get: (slug: string) => DraftRecord | undefined;
  requireOpen: (slug: string) => DraftRecord;
  create: (
    user: SessionUser,
    title: string,
    options?: { agentFor?: number },
  ) => Promise<DraftRecord>;
  rename: (slug: string, title: string) => DraftRecord;
  changes: (slug: string) => PageChange[];
  drift: (slug: string) => LiveDrift;
  markReady: (
    slug: string,
    user: SessionUser,
    logins: string[],
    note: string,
  ) => Promise<DraftRecord>;
  markDraft: (slug: string) => DraftRecord;
  review: (
    slug: string,
    user: SessionUser,
    verdict: 'approved' | 'changes',
    note: string,
  ) => DraftRecord;
  publish: (slug: string, user: SessionUser) => Promise<DraftRecord>;
  discard: (slug: string, user: SessionUser) => Promise<DraftRecord>;
  update: (
    slug: string,
    user: SessionUser,
    resolved?: Record<string, string>,
  ) => Promise<UpdateResult>;
  moveRecentEdits: (user: SessionUser, path: string, title: string) => Promise<DraftRecord>;
  agentDraft: (user: SessionUser) => Promise<DraftRecord>;
  agentMode: (userId: number) => AgentMode;
  setAgentMode: (userId: number, mode: AgentMode) => void;
  reviewMentions: () => Mention[];
  followRemote: () => Promise<void>;
}

export function createDraftService(deps: DraftServiceDeps): DraftService {
  const now = deps.now ?? (() => new Date());
  const { store, instances, remote, runGit } = deps;
  const pageCache = new Map<string, { at: number; pages: ChangedPage[] }>();

  function stamp(): string {
    return now().toISOString();
  }

  function pagesOf(draft: DraftRecord): ChangedPage[] {
    if (!isOpen(draft)) return [];
    const cached = pageCache.get(draft.slug);
    if (cached !== undefined && now().getTime() - cached.at < PAGES_CACHE_MS) return cached.pages;
    const dir = instances.dir(draft.slug);
    let pages: ChangedPage[] = [];
    if (existsSync(join(dir, '.git'))) {
      try {
        pages = changedPages(runGit, dir, draft.baseSha);
      } catch (err) {
        deps.log.warn({ err, draft: draft.slug }, '[gitquire-drafts] could not list changed pages');
      }
    }
    pageCache.set(draft.slug, { at: now().getTime(), pages });
    return pages;
  }

  function summary(draft: DraftRecord): DraftSummary {
    return {
      slug: draft.slug,
      title: draft.title,
      status: draft.status,
      author: draft.author,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      base: draft.base,
      pullUrl: remote.pullUrl(draft) ?? null,
      reviews: draft.reviews,
      requests: draft.requests,
      pages: pagesOf(draft),
      agent: draft.agentFor !== undefined,
      closedAt: draft.closedAt ?? null,
      closedBy: draft.closedBy ?? null,
    };
  }

  function list(): DraftSummary[] {
    const all = store.all();
    const open = all.filter(isOpen);
    const closed = all
      .filter((draft) => !isOpen(draft))
      .sort((a, b) => ((a.closedAt ?? '') < (b.closedAt ?? '') ? 1 : -1))
      .slice(0, CLOSED_KEEP);
    return [...open, ...closed].map(summary);
  }

  function requireOpen(slug: string): DraftRecord {
    const draft = store.get(slug);
    if (draft === undefined)
      throw new DraftError(404, 'draft-not-found', 'There is no such draft.');
    if (!isOpen(draft)) {
      throw new DraftError(409, 'draft-closed', `"${draft.title}" was already ${draft.status}.`);
    }
    return draft;
  }

  function save(draft: DraftRecord): DraftRecord {
    draft.updatedAt = stamp();
    store.put(draft);
    pageCache.delete(draft.slug);
    return draft;
  }

  async function create(
    user: SessionUser,
    title: string,
    options: { agentFor?: number } = {},
  ): Promise<DraftRecord> {
    const base = await deps.baseBranch();
    const baseSha = await remote.headSha(base);
    if (baseSha === undefined) {
      throw new DraftError(
        409,
        'no-base',
        `The branch ${base} does not exist yet. Wait for the first sync.`,
      );
    }
    const taken = new Set(store.all().map((draft) => draft.slug));
    const slug = uniqueSlug(title, (candidate) => taken.has(candidate));
    const branch = `${DRAFT_BRANCH_PREFIX}${slug}`;
    if ((await remote.headSha(branch)) !== undefined) {
      throw new DraftError(409, 'branch-exists', `A branch named ${branch} already exists.`);
    }
    await remote.createBranch(branch, baseSha);
    const at = stamp();
    const draft: DraftRecord = {
      slug,
      branch,
      title,
      base,
      baseSha,
      author: personOf(user),
      createdAt: at,
      updatedAt: at,
      status: 'draft',
      reviews: [],
      requests: [],
      ...(options.agentFor === undefined ? {} : { agentFor: options.agentFor }),
    };
    store.put(draft);
    deps.log.info({ draft: slug, by: user.login }, '[gitquire-drafts] created a draft');
    return draft;
  }

  function rename(slug: string, title: string): DraftRecord {
    const draft = requireOpen(slug);
    draft.title = title;
    return save(draft);
  }

  function changes(slug: string): PageChange[] {
    const draft = requireOpen(slug);
    const dir = instances.dir(slug);
    if (!existsSync(join(dir, '.git'))) return [];
    return changedPages(runGit, dir, draft.baseSha).map((page) => ({
      ...page,
      before: clipText(
        page.change === 'added' ? null : fileAt(runGit, dir, draft.baseSha, page.path),
      ),
      after: clipText(page.change === 'deleted' ? null : workingFile(dir, page.path)),
    }));
  }

  function drift(slug: string): LiveDrift {
    const draft = requireOpen(slug);
    try {
      const live = headSha(runGit, deps.projectDir);
      if (live === draft.baseSha) return { behind: 0, pages: [] };
      const behind = Number(
        runGit(['rev-list', '--count', `${draft.baseSha}..${live}`], deps.projectDir).trim(),
      );
      const pages = runGit(
        ['diff', '--name-only', '--no-renames', draft.baseSha, live],
        deps.projectDir,
      )
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && isPagePath(line));
      return { behind: Number.isFinite(behind) ? behind : 0, pages };
    } catch {
      return { behind: 0, pages: [] };
    }
  }

  async function saveAndPush(draft: DraftRecord, who: GitIdentity): Promise<void> {
    const dir = instances.dir(draft.slug);
    if (!existsSync(join(dir, '.git'))) return;
    await instances.halt(draft.slug);
    commitPending(runGit, dir, 'Save draft edits', who);
    pushBranch(runGit, dir, draft.branch, deps.authEnv());
  }

  async function markReady(
    slug: string,
    user: SessionUser,
    logins: string[],
    note: string,
  ): Promise<DraftRecord> {
    return instances.exclusive(slug, async () => {
      const draft = requireOpen(slug);
      if (!changesExist(draft)) {
        throw new DraftError(409, 'no-changes', 'Nothing has changed in this draft yet.');
      }
      await saveAndPush(draft, identityOf(user));
      const body = `Draft "${draft.title}" from GitQuire, started by @${draft.author.login}.${note.trim() === '' ? '' : `\n\n${note.trim()}`}`;
      try {
        const pull = await remote.openReview(draft, body);
        if (pull !== undefined) draft.pull = pull;
      } catch (err) {
        deps.log.warn({ err, draft: slug }, '[gitquire-drafts] could not open the pull request');
      }
      draft.status = 'review';
      const unique = [...new Set(logins.map((login) => login.toLowerCase()))].filter(
        (login) => login !== user.login.toLowerCase(),
      );
      if (unique.length > 0 || note.trim() !== '') {
        draft.requests = [
          ...draft.requests,
          { id: randomUUID(), by: personOf(user), logins: unique, note: note.trim(), at: stamp() },
        ];
      }
      return save(draft);
    });
  }

  function changesExist(draft: DraftRecord): boolean {
    pageCache.delete(draft.slug);
    return pagesOf(draft).length > 0;
  }

  function markDraft(slug: string): DraftRecord {
    const draft = requireOpen(slug);
    draft.status = 'draft';
    return save(draft);
  }

  function review(
    slug: string,
    user: SessionUser,
    verdict: 'approved' | 'changes',
    note: string,
  ): DraftRecord {
    const draft = requireOpen(slug);
    const login = user.login.toLowerCase();
    draft.reviews = [
      ...draft.reviews.filter((entry) => entry.login.toLowerCase() !== login),
      {
        login: user.login,
        ...(user.name ? { name: user.name } : {}),
        verdict,
        note: note.trim(),
        at: stamp(),
      },
    ];
    return save(draft);
  }

  async function close(
    draft: DraftRecord,
    status: 'published' | 'discarded',
    by: DraftPerson | undefined,
  ): Promise<DraftRecord> {
    await instances.erase(draft.slug);
    draft.status = status;
    draft.closedAt = stamp();
    if (by !== undefined) draft.closedBy = by;
    return save(draft);
  }

  async function publish(slug: string, user: SessionUser): Promise<DraftRecord> {
    return instances.exclusive(slug, async () => {
      const draft = requireOpen(slug);
      const who = identityOf(user);
      await saveAndPush(draft, who);
      const result = await remote.publish(draft, draft.title, who);
      if (!result.ok) {
        throw new DraftError(
          409,
          'conflict',
          'The live wiki changed in the same places. Update the draft first, then publish.',
        );
      }
      deps.log.info(
        { draft: slug, by: user.login, sha: result.sha },
        '[gitquire-drafts] published',
      );
      const closed = await close(draft, 'published', personOf(user));
      deps.onPublished?.();
      return closed;
    });
  }

  async function discard(slug: string, user: SessionUser): Promise<DraftRecord> {
    return instances.exclusive(slug, async () => {
      const draft = requireOpen(slug);
      try {
        await remote.close(draft);
      } catch (err) {
        deps.log.warn({ err, draft: slug }, '[gitquire-drafts] could not delete the draft branch');
      }
      deps.log.info({ draft: slug, by: user.login }, '[gitquire-drafts] discarded');
      return close(draft, 'discarded', personOf(user));
    });
  }

  async function update(
    slug: string,
    user: SessionUser,
    resolved?: Record<string, string>,
  ): Promise<UpdateResult> {
    return instances.exclusive(slug, async () => {
      const draft = requireOpen(slug);
      const dir = instances.dir(slug);
      if (!existsSync(join(dir, '.git'))) {
        throw new DraftError(409, 'draft-not-ready', 'Open the draft once before updating it.');
      }
      const who = identityOf(user);
      await instances.halt(slug);
      commitPending(runGit, dir, 'Save draft edits', who);
      const liveSha = fetchBranch(runGit, dir, draft.base, deps.authEnv());
      const outcome = mergeBase(runGit, dir, draft.base, who, resolved);
      if (outcome.kind === 'conflicts') return outcome;
      if (outcome.kind === 'merged') pushBranch(runGit, dir, draft.branch, deps.authEnv());
      draft.baseSha = liveSha;
      save(draft);
      return { kind: outcome.kind === 'merged' ? 'updated' : 'up-to-date' };
    });
  }

  async function moveRecentEdits(
    user: SessionUser,
    path: string,
    title: string,
  ): Promise<DraftRecord> {
    if (!isPagePath(path)) throw new DraftError(400, 'invalid-path', 'Choose a page.');
    const live = deps.projectDir;
    const mine = noreplyEmail(user).toLowerCase();
    const commits = commitsTouching(runGit, live, path);
    const dirty = runGit(['status', '--porcelain', ...pathspecArgs([path])], live).trim() !== '';
    const cutoff = now().getTime() - RETRO_WINDOW_MS;
    let oldest: string | undefined;
    for (const commit of commits) {
      if (commit.email !== mine || commit.at < cutoff) break;
      oldest = commit.sha;
    }
    if (oldest === undefined && !dirty) {
      throw new DraftError(
        409,
        'no-recent-edits',
        'You have no recent edits on this page, or someone else edited it after you.',
      );
    }
    const before =
      oldest === undefined
        ? fileAt(runGit, live, 'HEAD', path)
        : fileAt(runGit, live, `${oldest}^`, path);
    const after = workingFile(live, path);
    const draft = await create(user, title);
    await instances.exclusive(draft.slug, async () => {
      const dir = instances.dir(draft.slug);
      await instances.halt(draft.slug);
      await instances.prepareDir(draft);
      const target = join(dir, path);
      if (after === null) {
        if (existsSync(target)) unlinkSync(target);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, after);
      }
      commitPending(runGit, dir, `Move recent edits of ${path} into this draft`, identityOf(user));
      pushBranch(runGit, dir, draft.branch, deps.authEnv());
    });
    const liveFile = join(live, path);
    if (before === null) {
      if (existsSync(liveFile)) rmSync(liveFile);
    } else {
      mkdirSync(dirname(liveFile), { recursive: true });
      writeFileSync(liveFile, before);
    }
    deps.log.info(
      { draft: draft.slug, path, by: user.login },
      '[gitquire-drafts] moved recent edits into a draft',
    );
    return draft;
  }

  async function agentDraft(user: SessionUser): Promise<DraftRecord> {
    const existing = store.all().find((draft) => draft.agentFor === user.id && isOpen(draft));
    if (existing !== undefined) return existing;
    return create(user, `Claude's changes for ${user.name || user.login}`, { agentFor: user.id });
  }

  function reviewMentions(): Mention[] {
    const out: Mention[] = [];
    for (const draft of store.all()) {
      if (draft.status !== 'review') continue;
      for (const request of draft.requests) {
        if (request.logins.length === 0) continue;
        out.push({
          id: `draft:${draft.slug}:${request.id}`,
          path: '',
          docName: draft.title,
          threadId: '',
          commentId: request.id,
          author: {
            id: `github-${request.by.id}`,
            login: request.by.login,
            ...(request.by.name ? { name: request.by.name } : {}),
          },
          at: request.at,
          body: request.note,
          quote: draft.title,
          resolved: false,
          logins: request.logins,
          draft: { slug: draft.slug, title: draft.title },
        });
      }
    }
    return out;
  }

  async function followRemote(): Promise<void> {
    for (const draft of store.all().filter(isOpen)) {
      try {
        const state = await remote.closedElsewhere(draft);
        if (state === undefined) continue;
        await instances.exclusive(draft.slug, () =>
          close(draft, state === 'merged' ? 'published' : 'discarded', undefined),
        );
        deps.log.info({ draft: draft.slug, state }, '[gitquire-drafts] draft was closed on GitHub');
      } catch (err) {
        deps.log.warn(
          { err, draft: draft.slug },
          '[gitquire-drafts] could not check the draft on GitHub',
        );
      }
    }
  }

  return {
    list,
    summary,
    get: (slug) => store.get(slug),
    requireOpen,
    create,
    rename,
    changes,
    drift,
    markReady,
    markDraft,
    review,
    publish,
    discard,
    update,
    moveRecentEdits,
    agentDraft,
    agentMode: (userId) => store.agentMode(userId),
    setAgentMode: (userId, mode) => store.setAgentMode(userId, mode),
    reviewMentions,
    followRemote,
  };
}
