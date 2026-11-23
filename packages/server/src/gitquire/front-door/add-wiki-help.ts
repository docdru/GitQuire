import type { DoorHost } from '../host/types.ts';
import type { AddWikiHelp } from './pages.ts';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function githubAppInstallUrl(
  apiUrl: string,
  jwt: () => string,
  doFetch: Fetch = fetch,
): Promise<string | undefined> {
  const response = await doFetch(`${apiUrl}/app`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt()}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) return undefined;
  const body = (await response.json().catch(() => undefined)) as { html_url?: unknown } | undefined;
  const page = body?.html_url;
  if (typeof page !== 'string' || !page.startsWith('https://')) return undefined;
  return `${page.replace(/\/+$/, '')}/installations/new`;
}

export function cachedAddWikiHelp(find: () => Promise<AddWikiHelp>): () => Promise<AddWikiHelp> {
  let found: AddWikiHelp | undefined;
  return async () => {
    if (found !== undefined) return found;
    const help = await find();
    if (help.installUrl !== undefined || help.botLogin !== undefined) found = help;
    return help;
  };
}

export function addWikiHelpFor(options: {
  host: DoorHost;
  kind: 'github' | 'forgejo';
  apiUrl: string;
  jwt: () => string;
  botToken: () => string | undefined;
  doFetch?: Fetch;
}): () => Promise<AddWikiHelp> {
  return cachedAddWikiHelp(async () => {
    if (options.kind === 'github') {
      const installUrl = await githubAppInstallUrl(options.apiUrl, options.jwt, options.doFetch);
      return installUrl === undefined ? {} : { installUrl };
    }
    const token = options.botToken();
    const bot = token === undefined ? undefined : await options.host.person(token);
    return bot === undefined ? {} : { botLogin: bot.login };
  });
}
