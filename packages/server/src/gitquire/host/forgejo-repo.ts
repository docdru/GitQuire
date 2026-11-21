import { readFileSync } from 'node:fs';
import {
  type GitHubAppClient,
  GitHubAppConfigError,
  GitHubUnavailableError,
  type RetryOptions,
  retryWhileUnavailable,
} from '../github-app.ts';
import { parseGitHubRepo } from '../github-auth-config.ts';
import { parseHostKind } from './names.ts';
import type { HostRepo } from './types.ts';

type Env = Readonly<Record<string, string | undefined>>;

const TOKEN_RECHECK_MS = 12 * 60 * 60 * 1000;

export interface ForgejoRepoConfig {
  repo: HostRepo;
  branch: string | undefined;
  webUrl: string;
  apiUrl: string;
  gitHost: string;
  botToken: string | undefined;
  repoToken: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function secret(env: Env, name: string, readFile: (path: string) => string): string | undefined {
  const inline = nonEmpty(env[name]);
  if (inline !== undefined) return inline;
  const file = nonEmpty(env[`${name}_FILE`]);
  if (file === undefined) return undefined;
  try {
    return nonEmpty(readFile(file));
  } catch (err) {
    throw new GitHubAppConfigError(
      `Could not read ${name}_FILE (${file}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function resolveForgejoRepoConfig(
  env: Env,
  options: { needBotToken?: boolean; readFile?: (path: string) => string } = {},
): ForgejoRepoConfig | undefined {
  if (parseHostKind(env) !== 'forgejo') return undefined;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const needBotToken = options.needBotToken ?? true;
  const web = nonEmpty(env.GITQUIRE_HOST_URL);
  const botToken = secret(env, 'GITQUIRE_HOST_TOKEN', readFile);
  const repoToken = secret(env, 'GITQUIRE_HOST_REPO_TOKEN', readFile);
  const repoRaw = nonEmpty(env.GITQUIRE_REPO);
  const missing: string[] = [];
  if (web === undefined) missing.push('GITQUIRE_HOST_URL');
  if (repoRaw === undefined) missing.push('GITQUIRE_REPO');
  if (botToken === undefined && needBotToken) {
    missing.push('GITQUIRE_HOST_TOKEN (or GITQUIRE_HOST_TOKEN_FILE)');
  }
  if (repoToken === undefined) {
    missing.push('GITQUIRE_HOST_REPO_TOKEN (or GITQUIRE_HOST_REPO_TOKEN_FILE)');
  }
  if (web === undefined || repoRaw === undefined || repoToken === undefined || missing.length > 0) {
    throw new GitHubAppConfigError(
      `Forgejo repository sync needs these settings: ${missing.join(', ')}.`,
    );
  }
  if (botToken === repoToken) {
    throw new GitHubAppConfigError(
      "GITQUIRE_HOST_TOKEN and GITQUIRE_HOST_REPO_TOKEN must be two different tokens: the bot account's unlimited token for access checks, and a token limited to the wiki's repository for Git and pull requests.",
    );
  }
  let url: URL;
  try {
    url = new URL(web);
  } catch {
    throw new GitHubAppConfigError(`GITQUIRE_HOST_URL is not a valid URL: "${web}".`);
  }
  if (url.protocol !== 'https:') {
    throw new GitHubAppConfigError(
      "GITQUIRE_HOST_URL must start with https://: Git only sends GitQuire's token over https.",
    );
  }
  const repo = parseGitHubRepo(repoRaw);
  if (repo === undefined) throw new GitHubAppConfigError('GITQUIRE_REPO is required.');
  const webUrl = web.replace(/\/+$/, '');
  return {
    repo,
    branch: nonEmpty(env.GITQUIRE_BRANCH),
    webUrl,
    apiUrl: (nonEmpty(env.GITQUIRE_HOST_API_URL) ?? `${webUrl}/api/v1`).replace(/\/+$/, ''),
    gitHost: url.host,
    botToken,
    repoToken,
  };
}

export function createForgejoRepoClient(
  config: ForgejoRepoConfig,
  deps: { fetch?: typeof fetch; now?: () => number; retry?: RetryOptions } = {},
): GitHubAppClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const label = `${config.repo.owner}/${config.repo.name}`;
  const path = `/repos/${encodeURIComponent(config.repo.owner)}/${encodeURIComponent(config.repo.name)}`;

  async function repoInfo(token: string): Promise<{ defaultBranch: string; cloneUrl: string }> {
    let response: Response;
    try {
      response = await doFetch(`${config.apiUrl}${path}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `token ${token}`,
          'User-Agent': 'GitQuire',
        },
      });
    } catch (err) {
      throw new GitHubUnavailableError(
        `Could not reach Forgejo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (response.status >= 500 || response.status === 429) {
      throw new GitHubUnavailableError(`Forgejo answered HTTP ${response.status}.`);
    }
    const body = (await response.json().catch(() => undefined)) as
      | { default_branch?: unknown; message?: unknown }
      | undefined;
    if (response.status !== 200 || typeof body?.default_branch !== 'string') {
      throw new GitHubAppConfigError(
        `Could not read ${label} with GITQUIRE_HOST_REPO_TOKEN (HTTP ${response.status}: ${typeof body?.message === 'string' ? body.message : 'no message'}).`,
      );
    }
    return { defaultBranch: body.default_branch, cloneUrl: `${config.webUrl}/${label}.git` };
  }

  return {
    mintInstallationToken: async () => ({
      token: config.repoToken,
      expiresAt: now() + TOKEN_RECHECK_MS,
      contents: 'write',
    }),
    repoInfo: (token) => retryWhileUnavailable(() => repoInfo(token), deps.retry),
  };
}
