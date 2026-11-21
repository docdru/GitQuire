import { browserClientVersionHeaders } from '@/lib/client-version';
import { withWikiPrefix } from '@/lib/gitquire/wiki-prefix';

interface ClientFetchConfig {
  apiOrigin?: string;
  pathPrefix?: string;
}

const FETCH_WRAPPER_MARKER = Symbol.for('ok.client.fetchWrapper');

export function installClientFetchWrapper(config: ClientFetchConfig = {}): void {
  if (typeof window === 'undefined') return;
  const apiOrigin = config.apiOrigin && config.apiOrigin.length > 0 ? config.apiOrigin : undefined;
  const pathPrefix = config.pathPrefix ?? '';

  const current = window.fetch as typeof window.fetch & { [FETCH_WRAPPER_MARKER]?: true };
  if (current[FETCH_WRAPPER_MARKER]) return;

  const origFetch = window.fetch.bind(window);
  const versionHeaders = browserClientVersionHeaders();

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = resolveApiTarget(input, apiOrigin);
    if (!target.isApi) {
      const moved = pathPrefix === '' ? undefined : prefixedSameOrigin(target.url, pathPrefix);
      if (moved === undefined || moved === target.url) return origFetch(input, init);
      return input instanceof Request
        ? origFetch(new Request(moved, input))
        : origFetch(moved, init);
    }
    const url =
      pathPrefix === '' ? target.url : (prefixedSameOrigin(target.url, pathPrefix) ?? target.url);

    if (input instanceof Request) {
      const headers = mergeHeaders(input.headers, versionHeaders);
      return origFetch(new Request(url, input), { headers });
    }
    const headers = mergeHeaders(init?.headers, versionHeaders);
    return origFetch(url, { ...init, headers });
  }) as typeof window.fetch & { [FETCH_WRAPPER_MARKER]?: true };

  wrapped[FETCH_WRAPPER_MARKER] = true;
  window.fetch = wrapped;
}

function prefixedSameOrigin(url: string, prefix: string): string | undefined {
  if (url.startsWith('/') && !url.startsWith('//')) return withWikiPrefix(url, prefix);
  const parsed = tryParseUrl(url);
  if (parsed === null || parsed.origin !== window.location.origin) return undefined;
  parsed.pathname = withWikiPrefix(parsed.pathname, prefix);
  return parsed.href;
}

function mergeHeaders(existing: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(existing);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

interface ApiTarget {
  isApi: boolean;
  url: string;
}

function resolveApiTarget(input: RequestInfo | URL, apiOrigin: string | undefined): ApiTarget {
  if (typeof input === 'string') {
    if (input.startsWith('/api/')) {
      return { isApi: true, url: apiOrigin ? apiOrigin + input : input };
    }
    const parsed = tryParseUrl(input);
    if (parsed && isLocalApiUrl(parsed, apiOrigin)) {
      return { isApi: true, url: rewriteToApiOrigin(parsed, input, apiOrigin) };
    }
    return { isApi: false, url: input };
  }

  const parsed = input instanceof URL ? input : tryParseUrl(input.url, window.location.origin);
  if (parsed && isLocalApiUrl(parsed, apiOrigin)) {
    const original = input instanceof URL ? input.href : input.url;
    return { isApi: true, url: rewriteToApiOrigin(parsed, original, apiOrigin) };
  }
  return { isApi: false, url: input instanceof URL ? input.href : input.url };
}

function rewriteToApiOrigin(parsed: URL, original: string, apiOrigin: string | undefined): string {
  if (apiOrigin && (parsed.origin === window.location.origin || parsed.protocol === 'file:')) {
    return apiOrigin + parsed.pathname + parsed.search + parsed.hash;
  }
  return original;
}

function tryParseUrl(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

function isLocalApiUrl(url: URL, apiOrigin: string | undefined): boolean {
  if (!url.pathname.startsWith('/api/')) return false;
  if (url.origin === window.location.origin || url.protocol === 'file:') return true;
  if (apiOrigin) {
    const api = tryParseUrl(apiOrigin);
    if (api && url.origin === api.origin) return true;
  }
  return false;
}
