import { describe, expect, it } from 'vitest';
import { GitHubUnavailableError } from './github-app.ts';
import { createGitHubPullsClient, GitHubRequestError } from './github-pulls.ts';

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function fakeFetch(answers: Array<{ status: number; body?: unknown }>) {
  const seen: Seen[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      auth: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = answers.shift();
    if (next === undefined) throw new Error('no more answers');
    const text = next.body === undefined ? '' : JSON.stringify(next.body);
    return new Response(text === '' ? null : text, { status: next.status });
  };
  return { fetch: impl as typeof fetch, seen };
}

const repo = { owner: 'acme', name: 'notes' };
const noRetry = { delaysMs: [] };

const rawPull = {
  number: 3,
  title: 'Q3 report',
  html_url: 'https://github.com/acme/notes/pull/3',
  head: { ref: 'report/q3' },
  base: { ref: 'main' },
  draft: false,
  user: { login: 'alice' },
  updated_at: '2026-11-10T09:00:00Z',
};

describe('createGitHubPullsClient', () => {
  it('lists open pull requests with the installation token', async () => {
    const { fetch, seen } = fakeFetch([{ status: 200, body: [rawPull, { number: 'bad' }] }]);
    const client = createGitHubPullsClient(repo, { token: () => 'ghs_x', fetch, retry: noRetry });
    expect(await client.listOpenPullRequests()).toEqual([
      {
        number: 3,
        title: 'Q3 report',
        url: 'https://github.com/acme/notes/pull/3',
        head: 'report/q3',
        base: 'main',
        draft: false,
        author: 'alice',
        updatedAt: '2026-11-10T09:00:00Z',
      },
    ]);
    expect(seen[0]?.url).toBe(
      'https://api.github.com/repos/acme/notes/pulls?state=open&per_page=50',
    );
    expect(seen[0]?.auth).toBe('Bearer ghs_x');
  });

  it('creates a pull request that maintainers can modify', async () => {
    const { fetch, seen } = fakeFetch([{ status: 201, body: rawPull }]);
    const client = createGitHubPullsClient(repo, {
      token: () => 'ghs_x',
      fetch,
      apiUrl: 'https://ghe.example.com/api/v3/',
      retry: noRetry,
    });
    const pull = await client.createPullRequest({
      title: 'Q3 report',
      body: 'Please review.',
      head: 'report/q3',
      base: 'main',
    });
    expect(pull.number).toBe(3);
    expect(seen[0]?.url).toBe('https://ghe.example.com/api/v3/repos/acme/notes/pulls');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toEqual({
      title: 'Q3 report',
      body: 'Please review.',
      head: 'report/q3',
      base: 'main',
      draft: false,
      maintainer_can_modify: true,
    });
  });

  it('reports validation failures with GitHub details', async () => {
    const { fetch } = fakeFetch([
      {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ message: 'A pull request already exists for acme:report/q3.' }],
        },
      },
    ]);
    const client = createGitHubPullsClient(repo, { token: () => 'ghs_x', fetch, retry: noRetry });
    const attempt = client.createPullRequest({ title: 't', body: '', head: 'a', base: 'main' });
    await expect(attempt).rejects.toBeInstanceOf(GitHubRequestError);
    await expect(attempt).rejects.toThrow(/already exists/);
  });

  it('checks branches and caches the default branch', async () => {
    const { fetch, seen } = fakeFetch([
      { status: 200, body: { name: 'report/q3' } },
      { status: 404, body: { message: 'Branch not found' } },
      { status: 200, body: { default_branch: 'trunk' } },
    ]);
    const client = createGitHubPullsClient(repo, { token: () => 'ghs_x', fetch, retry: noRetry });
    expect(await client.branchExists('report/q3')).toBe(true);
    expect(await client.branchExists('nope')).toBe(false);
    expect(await client.defaultBranch()).toBe('trunk');
    expect(await client.defaultBranch()).toBe('trunk');
    expect(seen).toHaveLength(3);
    expect(seen[0]?.url).toBe('https://api.github.com/repos/acme/notes/branches/report%2Fq3');
  });

  it('treats missing tokens and server errors as GitHub being unavailable', async () => {
    const missing = createGitHubPullsClient(repo, {
      token: () => undefined,
      fetch: fakeFetch([]).fetch,
      retry: noRetry,
    });
    await expect(missing.listOpenPullRequests()).rejects.toBeInstanceOf(GitHubUnavailableError);

    const { fetch } = fakeFetch([{ status: 502 }, { status: 200, body: [] }]);
    const retried = createGitHubPullsClient(repo, {
      token: () => 'ghs_x',
      fetch,
      retry: { delaysMs: [1], sleep: async () => {} },
    });
    expect(await retried.listOpenPullRequests()).toEqual([]);
  });
});
