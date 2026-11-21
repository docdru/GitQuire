import type { HostRepoRecord } from '../host/types.ts';

export type TokenScope =
  | 'limited'
  | 'not-the-bot'
  | 'not-limited'
  | 'cannot-read-owner'
  | 'unreachable';

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

  function loginOf(answer: Answer): string | undefined {
    if (answer.status !== 200) return undefined;
    const login = (answer.body as { login?: unknown } | undefined)?.login;
    return typeof login === 'string' ? login.toLowerCase() : undefined;
  }

  return async (repo, token) => {
    const bot = deps.botToken();
    if (bot === undefined) return 'unreachable';
    const [botUser, tokenUser] = await Promise.all([call('/user', bot), call('/user', token)]);
    if (botUser.status === 'unreachable' || tokenUser.status === 'unreachable') {
      return 'unreachable';
    }
    const botLogin = loginOf(botUser);
    const tokenLogin = loginOf(tokenUser);
    if (botLogin === undefined) return 'unreachable';
    if (tokenLogin === undefined) return 'cannot-read-owner';
    if (tokenLogin !== botLogin) return 'not-the-bot';
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
    for (const other of others) {
      const probe = await call(
        `${repoPath(String(other.owner?.login), String(other.name))}/contents`,
        token,
      );
      if (probe.status === 'unreachable') return 'unreachable';
      if (probe.status !== 403) return 'not-limited';
    }
    return 'limited';
  };
}
