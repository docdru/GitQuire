export const DRAFT_BRANCH_PREFIX = 'draft/';
export const VIEW_COOKIE = 'gq_view';
export const MAX_DRAFT_TITLE = 120;
const MAX_SLUG = 48;

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

export interface DraftRecord {
  slug: string;
  branch: string;
  title: string;
  base: string;
  baseSha: string;
  author: DraftPerson;
  createdAt: string;
  updatedAt: string;
  status: DraftStatus;
  pull?: number;
  reviews: DraftReview[];
  requests: ReviewRequest[];
  agentFor?: number;
  closedAt?: string;
  closedBy?: DraftPerson;
}

export function isOpen(draft: DraftRecord): boolean {
  return draft.status === 'draft' || draft.status === 'review';
}

export function slugify(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const clipped = ascii.slice(0, MAX_SLUG).replace(/-+$/g, '');
  return clipped === '' ? 'draft' : clipped;
}

export function uniqueSlug(title: string, taken: (slug: string) => boolean): string {
  const base = slugify(title);
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error('No free draft name.');
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value);
}

export function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\s+/g, ' ').trim();
  if (title === '' || title.length > MAX_DRAFT_TITLE) return undefined;
  return title;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function viewCookie(slug: string | null, secure: boolean): string {
  const flags = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  if (slug === null) return `${VIEW_COOKIE}=; Max-Age=0; ${flags}`;
  return `${VIEW_COOKIE}=${encodeURIComponent(slug)}; Max-Age=31536000; ${flags}`;
}

const LIVE_ONLY_PREFIXES = [
  '/auth/',
  '/.well-known/',
  '/api/gitquire/drafts',
  '/api/gitquire/view',
  '/api/gitquire/chat',
];
const LIVE_ONLY_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/mcp',
  '/api/gitquire/mentions',
  '/api/gitquire/mentions/read',
  '/api/gitquire/mentions/email',
  '/api/gitquire/mentions/email/confirm',
  '/api/gitquire/me/settings',
  '/api/gitquire/repository',
  '/api/gitquire/branches',
  '/api/gitquire/pulls',
]);

export function servedByLive(path: string): boolean {
  if (LIVE_ONLY_PATHS.has(path)) return true;
  if (path.startsWith('/mcp/')) return true;
  return LIVE_ONLY_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

export interface ChangedPage {
  path: string;
  change: 'added' | 'modified' | 'deleted';
}

export function parseNameStatus(output: string): ChangedPage[] {
  const pages: ChangedPage[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const [code, ...rest] = line.split('\t');
    const status = code?.[0];
    if (status === 'R' && rest.length >= 2) {
      pages.push({ path: rest[0] as string, change: 'deleted' });
      pages.push({ path: rest[1] as string, change: 'added' });
      continue;
    }
    const path = rest[0];
    if (path === undefined) continue;
    const change = status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified';
    pages.push({ path, change });
  }
  return pages;
}

export function isPagePath(path: string): boolean {
  if (path === '' || path.includes('\\') || path.includes('\0')) return false;
  return !path.split('/').some((segment) => segment === '' || segment.startsWith('.'));
}
