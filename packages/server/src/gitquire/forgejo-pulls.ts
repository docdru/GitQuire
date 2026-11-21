import { GitHubUnavailableError, type RetryOptions, retryWhileUnavailable } from './github-app.ts';
import {
  type CreatePullRequestInput,
  type GitHubDraftsClient,
  GitHubRequestError,
  type MergeOutcome,
  type PullRequestState,
  type PullRequestSummary,
  type RepoCollaborator,
  toSummary,
} from './github-pulls.ts';
import type { HostRepo } from './host/types.ts';

const MERGE_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 1000, 2000, 2000, 2000];

export interface ForgejoPullsDeps {
  token: () => string | undefined;
  apiUrl: string;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  mergeDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

function segments(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

export function createForgejoPullsClient(
  repo: HostRepo,
  deps: ForgejoPullsDeps,
): GitHubDraftsClient {
  const doFetch = deps.fetch ?? fetch;
  const apiUrl = deps.apiUrl.replace(/\/+$/, '');
  const repoPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function call(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown }> {
    const token = deps.token();
    if (token === undefined) {
      throw new GitHubUnavailableError('No Forgejo token is available yet.');
    }
    let response: Response;
    try {
      response = await doFetch(`${apiUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `token ${token}`,
          'User-Agent': 'GitQuire',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (err) {
      throw new GitHubUnavailableError(
        `Could not reach Forgejo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (response.status >= 500 || response.status === 429) {
      throw new GitHubUnavailableError(`Forgejo answered HTTP ${response.status}.`);
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
    const message = typeof raw === 'string' && raw !== '' ? raw : 'no message';
    throw new GitHubRequestError(status, `${what} failed (HTTP ${status}: ${message}).`);
  }

  async function listOpenPullRequests(): Promise<PullRequestSummary[]> {
    const { status, body } = await call(`${repoPath}/pulls?state=open&limit=50`);
    if (status !== 200 || !Array.isArray(body)) fail(status, body, 'Listing pull requests');
    return body
      .map((raw) => toSummary(raw as Record<string, unknown>))
      .filter((pr): pr is PullRequestSummary => pr !== undefined);
  }

  async function createPullRequest(input: CreatePullRequestInput): Promise<PullRequestSummary> {
    const { status, body } = await call(`${repoPath}/pulls`, {
      method: 'POST',
      body: { title: input.title, body: input.body, head: input.head, base: input.base },
    });
    const summary =
      status === 201 && typeof body === 'object' && body !== null
        ? toSummary(body as Record<string, unknown>)
        : undefined;
    if (summary === undefined) fail(status, body, 'Opening the pull request');
    return summary;
  }

  async function branchSha(branch: string): Promise<string | undefined> {
    const { status, body } = await call(`${repoPath}/branches/${segments(branch)}`);
    if (status === 404) return undefined;
    const sha = (body as { commit?: { id?: unknown } } | undefined)?.commit?.id;
    if (status !== 200 || typeof sha !== 'string') fail(status, body, 'Reading the branch');
    return sha;
  }

  async function branchExists(branch: string): Promise<boolean> {
    return (await branchSha(branch)) !== undefined;
  }

  async function mergedPullHeads(branch: string): Promise<string[]> {
    const { status, body } = await call(`${repoPath}/pulls?state=closed&limit=50`);
    if (status !== 200 || !Array.isArray(body)) fail(status, body, 'Listing merged pull requests');
    const heads: string[] = [];
    for (const raw of body as Array<{
      merged?: unknown;
      head?: { ref?: unknown; sha?: unknown };
    }>) {
      if (raw.merged === true && raw.head?.ref === branch && typeof raw.head.sha === 'string') {
        heads.push(raw.head.sha);
      }
    }
    return heads;
  }

  async function createBranchAt(branch: string, sha: string): Promise<void> {
    const { status, body } = await call(`${repoPath}/branches`, {
      method: 'POST',
      body: { new_branch_name: branch, old_ref_name: sha },
    });
    if (status !== 201) fail(status, body, 'Creating the branch');
  }

  async function deleteBranch(branch: string): Promise<void> {
    const { status, body } = await call(`${repoPath}/branches/${segments(branch)}`, {
      method: 'DELETE',
    });
    if (status !== 204 && status !== 404) fail(status, body, 'Deleting the branch');
  }

  async function readPull(number: number): Promise<{
    state: PullRequestState;
    mergeSha: string | undefined;
  }> {
    const { status, body } = await call(`${repoPath}/pulls/${number}`);
    const raw = body as
      | { state?: unknown; merged?: unknown; mergeable?: unknown; merge_commit_sha?: unknown }
      | undefined;
    if (status !== 200 || raw === undefined) fail(status, body, 'Reading the pull request');
    return {
      state: {
        number,
        state: raw.state === 'closed' ? 'closed' : 'open',
        merged: raw.merged === true,
        mergeable: typeof raw.mergeable === 'boolean' ? raw.mergeable : null,
      },
      mergeSha: typeof raw.merge_commit_sha === 'string' ? raw.merge_commit_sha : undefined,
    };
  }

  async function mergePull(number: number, title: string): Promise<MergeOutcome> {
    const delays = deps.mergeDelaysMs ?? MERGE_RETRY_DELAYS_MS;
    let lastMessage = '';
    for (let attempt = 0; ; attempt += 1) {
      const { status, body } = await call(`${repoPath}/pulls/${number}/merge`, {
        method: 'POST',
        body: { Do: 'squash', MergeTitleField: title, delete_branch_after_merge: false },
      });
      if (status === 200) break;
      const raw = (body as { message?: unknown } | undefined)?.message;
      lastMessage = typeof raw === 'string' && raw !== '' ? raw : `HTTP ${status}`;
      if (status === 409) return { merged: false, reason: 'conflict', message: lastMessage };
      if (status !== 405) return fail(status, body, 'Merging the pull request');
      const delay = delays.at(attempt);
      if (delay === undefined) break;
      await sleep(delay);
    }
    const after = await readPull(number);
    if (after.state.merged && after.mergeSha !== undefined) {
      return { merged: true, sha: after.mergeSha };
    }
    return {
      merged: false,
      reason: after.state.mergeable === false ? 'conflict' : 'not-mergeable',
      message: lastMessage === '' ? 'Forgejo did not merge the pull request.' : lastMessage,
    };
  }

  async function closePull(number: number): Promise<void> {
    const { status, body } = await call(`${repoPath}/pulls/${number}`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
    if (status !== 200 && status !== 201) fail(status, body, 'Closing the pull request');
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

  async function collaborators(): Promise<RepoCollaborator[]> {
    const { status, body } = await call(`${repoPath}/collaborators?limit=50`);
    if (status !== 200 || !Array.isArray(body)) fail(status, body, 'Listing collaborators');
    return body.flatMap((raw): RepoCollaborator[] => {
      const user = raw as { id?: unknown; login?: unknown; avatar_url?: unknown };
      if (typeof user.id !== 'number' || typeof user.login !== 'string') return [];
      return [
        {
          id: user.id,
          login: user.login,
          avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
        },
      ];
    });
  }

  return {
    defaultBranch: () => retryWhileUnavailable(defaultBranch, deps.retry),
    collaborators,
    listOpenPullRequests: () => retryWhileUnavailable(listOpenPullRequests, deps.retry),
    createPullRequest: (input) => retryWhileUnavailable(() => createPullRequest(input), deps.retry),
    branchExists: (branch) => retryWhileUnavailable(() => branchExists(branch), deps.retry),
    mergedPullHeads,
    branchSha: (branch) => retryWhileUnavailable(() => branchSha(branch), deps.retry),
    createBranchAt: (branch, sha) =>
      retryWhileUnavailable(() => createBranchAt(branch, sha), deps.retry),
    deleteBranch: (branch) => retryWhileUnavailable(() => deleteBranch(branch), deps.retry),
    pullState: (number) =>
      retryWhileUnavailable(async () => (await readPull(number)).state, deps.retry),
    mergePull: (number, title) => mergePull(number, title),
    closePull: (number) => retryWhileUnavailable(() => closePull(number), deps.retry),
  };
}
