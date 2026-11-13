import { GitHubUnavailableError, type RetryOptions, retryWhileUnavailable } from './github-app.ts';
import type { GitHubRepoRef } from './github-auth-config.ts';

const GITHUB_API_VERSION = '2022-11-28';

export class GitHubRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubRequestError';
    this.status = status;
  }
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  draft: boolean;
  author: string;
  updatedAt: string;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface GitHubPullsClient {
  listOpenPullRequests: () => Promise<PullRequestSummary[]>;
  createPullRequest: (input: CreatePullRequestInput) => Promise<PullRequestSummary>;
  branchExists: (branch: string) => Promise<boolean>;
  defaultBranch: () => Promise<string>;
  mergedPullHeads?: (branch: string) => Promise<string[]>;
}

export interface GitHubPullsDeps {
  token: () => string | undefined;
  apiUrl?: string;
  fetch?: typeof fetch;
  retry?: RetryOptions;
}

function toSummary(raw: Record<string, unknown>): PullRequestSummary | undefined {
  const head = raw.head as { ref?: unknown } | undefined;
  const base = raw.base as { ref?: unknown } | undefined;
  const user = raw.user as { login?: unknown } | undefined;
  if (
    typeof raw.number !== 'number' ||
    typeof raw.title !== 'string' ||
    typeof raw.html_url !== 'string' ||
    typeof head?.ref !== 'string' ||
    typeof base?.ref !== 'string'
  ) {
    return undefined;
  }
  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    head: head.ref,
    base: base.ref,
    draft: raw.draft === true,
    author: typeof user?.login === 'string' ? user.login : '',
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  };
}

export function createGitHubPullsClient(
  repo: GitHubRepoRef,
  deps: GitHubPullsDeps,
): GitHubPullsClient {
  const doFetch = deps.fetch ?? fetch;
  const apiUrl = (deps.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const repoPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  async function call(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown }> {
    const token = deps.token();
    if (token === undefined) {
      throw new GitHubUnavailableError('No GitHub App installation token is available yet.');
    }
    let response: Response;
    try {
      response = await doFetch(`${apiUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'GitQuire',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (err) {
      throw new GitHubUnavailableError(
        `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (response.status >= 500 || response.status === 429) {
      throw new GitHubUnavailableError(`GitHub answered HTTP ${response.status}.`);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  function fail(status: number, body: unknown, what: string): never {
    const raw = (body as { message?: unknown } | undefined)?.message;
    const message = typeof raw === 'string' ? raw : 'no message';
    const errors = (body as { errors?: Array<{ message?: unknown }> } | undefined)?.errors;
    const detail = Array.isArray(errors)
      ? errors
          .map((e) => (typeof e.message === 'string' ? e.message : ''))
          .filter((m) => m !== '')
          .join('; ')
      : '';
    throw new GitHubRequestError(
      status,
      `${what} failed (HTTP ${status}: ${message}${detail === '' ? '' : ` — ${detail}`}).`,
    );
  }

  async function listOpenPullRequests(): Promise<PullRequestSummary[]> {
    const { status, body } = await call(`${repoPath}/pulls?state=open&per_page=50`);
    if (status !== 200 || !Array.isArray(body)) fail(status, body, 'Listing pull requests');
    return body
      .map((raw) => toSummary(raw as Record<string, unknown>))
      .filter((pr): pr is PullRequestSummary => pr !== undefined);
  }

  async function createPullRequest(input: CreatePullRequestInput): Promise<PullRequestSummary> {
    const { status, body } = await call(`${repoPath}/pulls`, {
      method: 'POST',
      body: {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
        maintainer_can_modify: true,
      },
    });
    const summary =
      status === 201 && typeof body === 'object' && body !== null
        ? toSummary(body as Record<string, unknown>)
        : undefined;
    if (summary === undefined) fail(status, body, 'Opening the pull request');
    return summary;
  }

  async function branchExists(branch: string): Promise<boolean> {
    const { status, body } = await call(`${repoPath}/branches/${encodeURIComponent(branch)}`);
    if (status === 200) return true;
    if (status === 404) return false;
    return fail(status, body, 'Checking the branch');
  }

  async function mergedPullHeads(branch: string): Promise<string[]> {
    const head = encodeURIComponent(`${repo.owner}:${branch}`);
    const { status, body } = await call(`${repoPath}/pulls?state=closed&head=${head}&per_page=20`);
    if (status !== 200 || !Array.isArray(body)) fail(status, body, 'Listing merged pull requests');
    const heads: string[] = [];
    for (const raw of body as Array<{ merged_at?: unknown; head?: { sha?: unknown } }>) {
      if (typeof raw.merged_at === 'string' && typeof raw.head?.sha === 'string') {
        heads.push(raw.head.sha);
      }
    }
    return heads;
  }

  let cachedDefault: string | undefined;
  async function defaultBranch(): Promise<string> {
    if (cachedDefault !== undefined) return cachedDefault;
    const { status, body } = await call(repoPath);
    const name = (body as { default_branch?: unknown } | undefined)?.default_branch;
    if (status !== 200 || typeof name !== 'string') fail(status, body, 'Reading the repository');
    cachedDefault = name;
    return name;
  }

  return {
    defaultBranch: () => retryWhileUnavailable(defaultBranch, deps.retry),
    listOpenPullRequests: () => retryWhileUnavailable(listOpenPullRequests, deps.retry),
    createPullRequest: (input) => retryWhileUnavailable(() => createPullRequest(input), deps.retry),
    branchExists: (branch) => retryWhileUnavailable(() => branchExists(branch), deps.retry),
    mergedPullHeads,
  };
}
