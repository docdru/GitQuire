import type { IncomingMessage } from 'node:http';
import { FORWARDED_VIEW_HEADER } from '../request-person.ts';
import { serializeCookie } from '../signed-cookie.ts';

export interface WikiAddress {
  hostKey: string;
  owner: string;
  name: string;
  rest: string;
  search: string;
}

const SEGMENT = '[A-Za-z0-9._~-]+';
const WIKI_PATH_RE = new RegExp(`^/w/([a-z][a-z0-9-]*)/(${SEGMENT})/(${SEGMENT})(/[^?#]*)?$`);
const FRONT_DOOR_COOKIES = ['gq_session', 'gq_oauth_state'];
const FRONT_DOOR_COOKIE_PREFIXES = ['gq_oauth_state_'];
const VIEW_COOKIE_PREFIX = 'gq_view_';

function isNameSegment(value: string): boolean {
  return value !== '.' && value !== '..';
}

export function rawPathAndSearch(url: string | undefined): { path: string; search: string } {
  const raw = url ?? '/';
  const query = raw.indexOf('?');
  return query === -1
    ? { path: raw, search: '' }
    : { path: raw.slice(0, query), search: raw.slice(query) };
}

export function parseWikiAddress(url: string | undefined): WikiAddress | undefined {
  const { path, search } = rawPathAndSearch(url);
  const match = WIKI_PATH_RE.exec(path);
  if (match === null) return undefined;
  const [, hostKey, owner, name, rest] = match as unknown as [
    string,
    string,
    string,
    string,
    string?,
  ];
  if (!isNameSegment(owner) || !isNameSegment(name)) return undefined;
  return { hostKey, owner, name, rest: rest ?? '', search };
}

export function withPrefix(location: string, prefix: string): string {
  if (!location.startsWith('/') || location.startsWith('//') || location.startsWith('/\\')) {
    return location;
  }
  if (
    location === prefix ||
    location.startsWith(`${prefix}/`) ||
    location.startsWith(`${prefix}?`)
  ) {
    return location;
  }
  return `${prefix}${location}`;
}

export function viewCookieName(key: string): string {
  return `${VIEW_COOKIE_PREFIX}${key}`;
}

function viewCookie(key: string, slug: string, secure: boolean): string {
  return serializeCookie(viewCookieName(key), slug, {
    maxAgeSeconds: slug === '' ? 0 : 30 * 24 * 60 * 60,
    secure,
  });
}

export function stripBrowserHeaders(req: IncomingMessage): void {
  for (const name of Object.keys(req.headers)) {
    if (name.toLowerCase().startsWith('x-gitquire-')) delete req.headers[name];
  }
  const cookie = req.headers.cookie;
  if (cookie === undefined) return;
  const kept = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.slice(0, Math.max(0, part.indexOf('='))).trim();
      return (
        !FRONT_DOOR_COOKIES.includes(name) &&
        !FRONT_DOOR_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
        !name.startsWith(VIEW_COOKIE_PREFIX)
      );
    });
  if (kept.length === 0) {
    delete req.headers.cookie;
  } else {
    req.headers.cookie = kept.join('; ');
  }
}

export function translateResponseHeaders(
  headers: Record<string, string | string[]>,
  options: { prefix: string; key: string; secure: boolean },
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const cookies: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'set-cookie') continue;
    if (lower === FORWARDED_VIEW_HEADER) {
      cookies.push(
        viewCookie(options.key, Array.isArray(value) ? (value[0] ?? '') : value, options.secure),
      );
      continue;
    }
    if (lower === 'location' && typeof value === 'string') {
      out[name] = withPrefix(value, options.prefix);
      continue;
    }
    out[name] = value;
  }
  if (cookies.length > 0) out['set-cookie'] = cookies;
  return out;
}

export function refererAddress(req: IncomingMessage, origin: string): WikiAddress | undefined {
  const referer = req.headers.referer;
  if (typeof referer !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  return parseWikiAddress(url.pathname);
}
