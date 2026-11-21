const PREFIX_RE = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/;

function isValidPrefix(value: string): boolean {
  return PREFIX_RE.test(value) && !value.split('/').some((part) => part === '.' || part === '..');
}

export function prefixFromPath(pathname: string): string {
  const folder = pathname.slice(0, pathname.lastIndexOf('/'));
  return folder !== '' && isValidPrefix(folder) ? folder : '';
}

export function wikiPrefix(): string {
  if (typeof window === 'undefined' || typeof window.location?.pathname !== 'string') return '';
  return prefixFromPath(window.location.pathname);
}

export function hasWikiPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function withWikiPrefix(path: string, prefix: string = wikiPrefix()): string {
  if (prefix === '' || !path.startsWith('/') || path.startsWith('//')) return path;
  return hasWikiPrefix(path, prefix) ? path : `${prefix}${path}`;
}

export function wikiStorageNamespace(prefix: string = wikiPrefix()): string | null {
  return prefix === '' ? null : `wiki:${prefix}`;
}
