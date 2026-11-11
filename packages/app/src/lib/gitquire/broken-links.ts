import { isManagedArtifactDocName } from '@inkeep/open-knowledge-core/constants/cc1';
import type { ApiDeps } from './branch-api';

const AGENT_FOLDERS = new Set(['.agents', '.claude', '.cursor']);
const NOT_CONFIGURED = 'backlink-index-not-configured';
const MAX_BADGE = 99;

export interface BrokenLinkSource {
  docName: string;
  title: string;
  snippet: string | null;
}

export interface BrokenLink {
  target: string;
  sources: BrokenLinkSource[];
}

export interface BrokenLinkReport {
  available: boolean;
  links: BrokenLink[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSource(value: unknown): BrokenLinkSource | undefined {
  if (!isRecord(value) || typeof value.source !== 'string' || value.source === '') return undefined;
  return {
    docName: value.source,
    title: typeof value.title === 'string' && value.title !== '' ? value.title : value.source,
    snippet: typeof value.snippet === 'string' && value.snippet !== '' ? value.snippet : null,
  };
}

export function parseBrokenLinks(body: unknown): BrokenLink[] {
  if (!isRecord(body) || !Array.isArray(body.deadLinks)) return [];
  const links: BrokenLink[] = [];
  for (const entry of body.deadLinks) {
    if (!isRecord(entry) || typeof entry.target !== 'string' || entry.target === '') continue;
    const sources = Array.isArray(entry.sources)
      ? entry.sources.map(readSource).filter((source) => source !== undefined)
      : [];
    if (sources.length > 0) links.push({ target: entry.target, sources });
  }
  return links.sort(
    (a, b) => b.sources.length - a.sources.length || a.target.localeCompare(b.target),
  );
}

async function isNotConfigured(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.status !== 503) return false;
  const problem: unknown = await res.json().catch(() => undefined);
  if (!isRecord(problem) || typeof problem.type !== 'string') return false;
  return problem.type.includes(NOT_CONFIGURED);
}

export async function fetchBrokenLinks(deps: ApiDeps = {}): Promise<BrokenLinkReport> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch('/api/dead-links', { credentials: 'same-origin' });
  if (res.ok) return { available: true, links: parseBrokenLinks(await res.json()) };
  if (await isNotConfigured(res)) return { available: false, links: [] };
  throw new Error(`The broken-link report failed (HTTP ${res.status}).`);
}

export interface TeamPageRules {
  skipLogPages: boolean;
}

export function isTeamPage(docName: string, rules: TeamPageRules): boolean {
  if (isManagedArtifactDocName(docName)) return false;
  const segments = docName.split('/');
  if (segments.some((segment) => AGENT_FOLDERS.has(segment))) return false;
  const last = segments.at(-1)?.toLowerCase();
  return !(rules.skipLogPages && last === 'log');
}

export function teamBrokenLinks(links: readonly BrokenLink[], rules: TeamPageRules): BrokenLink[] {
  const kept: BrokenLink[] = [];
  for (const link of links) {
    const sources = link.sources.filter((source) => isTeamPage(source.docName, rules));
    if (sources.length > 0) kept.push({ target: link.target, sources });
  }
  return kept;
}

export function badgeCount(count: number): string {
  return count > MAX_BADGE ? `${MAX_BADGE}+` : String(count);
}

export function limitBrokenLinks(
  links: readonly BrokenLink[],
  maxSources: number,
): { links: BrokenLink[]; hidden: number } {
  const shown: BrokenLink[] = [];
  let room = maxSources;
  let hidden = 0;
  for (const link of links) {
    if (room <= 0) {
      hidden += link.sources.length;
      continue;
    }
    const sources = link.sources.slice(0, room);
    hidden += link.sources.length - sources.length;
    room -= sources.length;
    shown.push({ target: link.target, sources });
  }
  return { links: shown, hidden };
}

export function countBrokenLinks(links: readonly BrokenLink[]): number {
  return links.reduce((total, link) => total + link.sources.length, 0);
}

export function filterBrokenLinks(links: readonly BrokenLink[], query: string): BrokenLink[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') return [...links];
  const matches = (text: string): boolean => text.toLowerCase().includes(wanted);
  const found: BrokenLink[] = [];
  for (const link of links) {
    if (matches(link.target)) {
      found.push(link);
      continue;
    }
    const sources = link.sources.filter(
      (source) => matches(source.title) || matches(source.docName),
    );
    if (sources.length > 0) found.push({ target: link.target, sources });
  }
  return found;
}
