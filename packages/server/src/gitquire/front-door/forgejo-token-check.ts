import type { HostRepoRecord } from '../host/types.ts';

export type TokenScope = 'limited' | 'not-limited' | 'cannot-confirm' | 'unreachable';

type Answer = { status: number; body: unknown } | { status: 'unreachable' };

const PROBES = 3;

function repoPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function createForgejoTokenScopeCheck(deps: {
  apiUrl: string;
  botToken: () => string | undefined;
  fetch?: typeof fetch;
}): (repo: HostRepoRecord, token: string) => Promise<TokenScope> {
  const doFetch = deps.fetch ?? fetch;

  async function call(path: string, token: string): Promise<Answer> {
    try {
      const response = await doFetch(`${deps.apiUrl}${path}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'GitQuire',
          Authorization: `token ${token}`,
        },
      });
      if (response.status >= 500) return { status: 'unreachable' };
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, body };
    } catch {
      return { status: 'unreachable' };
    }
  }

  return async (repo, token) => {
    const bot = deps.botToken();
    if (bot === undefined) return 'unreachable';
    const person = await call('/user', token);
    if (person.status === 'unreachable') return 'unreachable';
    if (person.status === 200) return 'not-limited';
    const listed = await call('/user/repos?limit=50', bot);
    if (listed.status === 'unreachable') return 'unreachable';
    const others = (Array.isArray(listed.body) ? listed.body : [])
      .map((item) => item as { id?: unknown; name?: unknown; owner?: { login?: unknown } })
      .filter(
        (item) =>
          typeof item.id === 'number' &&
          item.id !== repo.id &&
          typeof item.name === 'string' &&
          typeof item.owner?.login === 'string',
      )
      .slice(0, PROBES);
    if (others.length === 0) return 'cannot-confirm';
    for (const other of others) {
      const path = `${repoPath(String(other.owner?.login), String(other.name))}/contents`;
      const probe = await call(path, token);
      if (probe.status === 'unreachable') return 'unreachable';
      if (probe.status === 403) continue;
      if (probe.status !== 404) return 'not-limited';
      const seen = await call(path, bot);
      if (seen.status === 'unreachable') return 'unreachable';
      if (seen.status !== 200) return 'cannot-confirm';
    }
    return 'limited';
  };
}
