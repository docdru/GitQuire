import { type ApiDeps, GitQuireApiError, gitquireRequest } from './branch-api';

export type DraftStatus = 'draft' | 'review' | 'published' | 'discarded';

export interface DraftPerson {
  id: number;
  login: string;
  name?: string;
}

export interface DraftReview {
  login: string;
  name?: string;
  verdict: 'approved' | 'changes';
  note: string;
  at: string;
}

export interface ReviewRequest {
  id: string;
  by: DraftPerson;
  logins: string[];
  note: string;
  at: string;
}

export interface ChangedPage {
  path: string;
  change: 'added' | 'modified' | 'deleted';
}

export interface DraftSummary {
  slug: string;
  title: string;
  status: DraftStatus;
  author: DraftPerson;
  createdAt: string;
  updatedAt: string;
  base: string;
  pullUrl: string | null;
  reviews: DraftReview[];
  requests: ReviewRequest[];
  pages: ChangedPage[];
  agent: boolean;
  closedAt: string | null;
  closedBy: DraftPerson | null;
}

export interface DraftList {
  enabled: boolean;
  me: string;
  viewing: string | null;
  drafts: DraftSummary[];
}

export interface LiveDrift {
  behind: number;
  pages: string[];
}

export interface ClosedDraft {
  slug: string;
  title: string;
  status: DraftStatus;
  closedBy: DraftPerson | null;
}

export interface CurrentDraft {
  viewing: DraftSummary | null;
  drift: LiveDrift | null;
  closed: ClosedDraft | null;
}

export interface PageChange extends ChangedPage {
  before: string | null;
  after: string | null;
}

export interface ConflictChunk {
  kind: 'same' | 'conflict';
  text?: string;
  live?: string;
  draft?: string;
  base?: string;
}

export interface FileConflict {
  path: string;
  chunks: ConflictChunk[];
}

export type UpdateResult =
  | { kind: 'up-to-date' | 'updated' }
  | { kind: 'conflicts'; files: FileConflict[] };

export type AgentMode = 'live' | 'draft';

const DISABLED: DraftList = { enabled: false, me: '', viewing: null, drafts: [] };

export async function fetchDrafts(deps: ApiDeps = {}): Promise<DraftList> {
  try {
    return await gitquireRequest<DraftList>('/api/gitquire/drafts', {}, deps);
  } catch (err) {
    if (err instanceof GitQuireApiError && (err.status === 404 || err.status === 401)) {
      return DISABLED;
    }
    throw err;
  }
}

export function fetchCurrentDraft(deps: ApiDeps = {}): Promise<CurrentDraft> {
  return gitquireRequest('/api/gitquire/drafts/current', {}, deps);
}

export async function createDraft(title: string, deps: ApiDeps = {}): Promise<DraftSummary> {
  const result = await gitquireRequest<{ draft: DraftSummary }>(
    '/api/gitquire/drafts',
    { method: 'POST', body: { title } },
    deps,
  );
  return result.draft;
}

export async function moveRecentEdits(
  path: string,
  title: string,
  deps: ApiDeps = {},
): Promise<DraftSummary> {
  const result = await gitquireRequest<{ draft: DraftSummary }>(
    '/api/gitquire/drafts/move',
    { method: 'POST', body: { path, title } },
    deps,
  );
  return result.draft;
}

export async function openView(slug: string | null, deps: ApiDeps = {}): Promise<void> {
  await gitquireRequest('/api/gitquire/view', { method: 'POST', body: { slug } }, deps);
}

function draftPath(slug: string, action: string): string {
  return `/api/gitquire/drafts/${encodeURIComponent(slug)}/${action}`;
}

async function draftAction(
  slug: string,
  action: string,
  body: Record<string, unknown>,
  deps: ApiDeps,
): Promise<DraftSummary> {
  const result = await gitquireRequest<{ draft: DraftSummary }>(
    draftPath(slug, action),
    { method: 'POST', body },
    deps,
  );
  return result.draft;
}

export async function fetchDraftChanges(slug: string, deps: ApiDeps = {}): Promise<PageChange[]> {
  const result = await gitquireRequest<{ pages: PageChange[] }>(
    draftPath(slug, 'changes'),
    {},
    deps,
  );
  return result.pages;
}

export function renameDraft(
  slug: string,
  title: string,
  deps: ApiDeps = {},
): Promise<DraftSummary> {
  return draftAction(slug, 'rename', { title }, deps);
}

export function markReady(
  slug: string,
  logins: string[],
  note: string,
  deps: ApiDeps = {},
): Promise<DraftSummary> {
  return draftAction(slug, 'ready', { logins, note }, deps);
}

export function markDraft(slug: string, deps: ApiDeps = {}): Promise<DraftSummary> {
  return draftAction(slug, 'unready', {}, deps);
}

export function reviewDraft(
  slug: string,
  verdict: DraftReview['verdict'],
  note: string,
  deps: ApiDeps = {},
): Promise<DraftSummary> {
  return draftAction(slug, 'review', { verdict, note }, deps);
}

export function publishDraft(slug: string, deps: ApiDeps = {}): Promise<DraftSummary> {
  return draftAction(slug, 'publish', {}, deps);
}

export function discardDraft(slug: string, deps: ApiDeps = {}): Promise<DraftSummary> {
  return draftAction(slug, 'discard', {}, deps);
}

export function updateDraft(
  slug: string,
  resolved?: Record<string, string>,
  deps: ApiDeps = {},
): Promise<UpdateResult> {
  return gitquireRequest(
    draftPath(slug, 'update'),
    { method: 'POST', body: resolved === undefined ? {} : { resolved } },
    deps,
  );
}

export async function fetchAgentMode(deps: ApiDeps = {}): Promise<AgentMode> {
  const result = await gitquireRequest<{ mode: AgentMode }>(
    '/api/gitquire/drafts/agent-mode',
    {},
    deps,
  );
  return result.mode;
}

export async function saveAgentMode(mode: AgentMode, deps: ApiDeps = {}): Promise<AgentMode> {
  const result = await gitquireRequest<{ mode: AgentMode }>(
    '/api/gitquire/drafts/agent-mode',
    { method: 'PUT', body: { mode } },
    deps,
  );
  return result.mode;
}

export function isOpenDraft(draft: Pick<DraftSummary, 'status'>): boolean {
  return draft.status === 'draft' || draft.status === 'review';
}

export function draftsTouching(
  drafts: readonly DraftSummary[],
  path: string | null,
): DraftSummary[] {
  if (path === null) return [];
  return drafts.filter(
    (draft) => isOpenDraft(draft) && draft.pages.some((page) => page.path === path),
  );
}

export function reviewState(draft: Pick<DraftSummary, 'reviews'>): 'approved' | 'changes' | 'none' {
  if (draft.reviews.some((review) => review.verdict === 'changes')) return 'changes';
  if (draft.reviews.some((review) => review.verdict === 'approved')) return 'approved';
  return 'none';
}

export function resolveConflict(
  file: FileConflict,
  choices: ReadonlyArray<string | undefined>,
): string {
  let conflictIndex = 0;
  let out = '';
  for (const chunk of file.chunks) {
    if (chunk.kind === 'same') {
      out += chunk.text ?? '';
      continue;
    }
    const choice = choices[conflictIndex];
    conflictIndex += 1;
    out += choice ?? chunk.draft ?? '';
  }
  return out;
}

export function conflictCount(file: FileConflict): number {
  return file.chunks.filter((chunk) => chunk.kind === 'conflict').length;
}
