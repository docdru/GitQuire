import type { ApiDeps } from './branch-api';

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

export async function fetchBrokenLinks(deps: ApiDeps = {}): Promise<BrokenLinkReport> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch('/api/dead-links', { credentials: 'same-origin' });
  if (res.status === 503 || res.status === 404) return { available: false, links: [] };
  if (!res.ok) throw new Error(`The broken-link report failed (HTTP ${res.status}).`);
  return { available: true, links: parseBrokenLinks(await res.json()) };
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
