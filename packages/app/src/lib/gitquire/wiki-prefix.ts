const WIKI_ADDRESS_RE = /^(\/w\/[a-z][a-z0-9-]*\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\//;

export function prefixFromPath(pathname: string): string {
  const prefix = WIKI_ADDRESS_RE.exec(pathname)?.[1];
  if (prefix === undefined) return '';
  const repo = prefix.slice(prefix.lastIndexOf('/') + 1);
  return repo === '.' || repo === '..' ? '' : prefix;
}

export function wikiPrefix(): string {
  if (typeof window === 'undefined' || typeof window.location?.pathname !== 'string') return '';
  return prefixFromPath(window.location.pathname);
}

export function hasWikiPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export const FRONT_DOOR_API = '/api/front-door';

function isFrontDoorPath(path: string): boolean {
  return path === FRONT_DOOR_API || path.startsWith(`${FRONT_DOOR_API}/`);
}

export function withWikiPrefix(path: string, prefix: string = wikiPrefix()): string {
  if (prefix === '' || !path.startsWith('/') || path.startsWith('//')) return path;
  if (isFrontDoorPath(path)) return path;
  return hasWikiPrefix(path, prefix) ? path : `${prefix}${path}`;
}

export function wikiStorageNamespace(prefix: string = wikiPrefix()): string | null {
  return prefix === '' ? null : `wiki:${prefix}`;
}
