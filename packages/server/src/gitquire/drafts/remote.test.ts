import { describe, expect, it } from 'vitest';
import {
  type GitHubDraftsClient,
  GitHubRequestError,
  type PullRequestSummary,
} from '../github-pulls.ts';
import type { DraftRecord } from './model.ts';
import { forgejoRemote, gitHubRemote } from './remote.ts';

function draft(): DraftRecord {
  return {
    slug: 'test-author',
    branch: 'draft/test-author',
    title: 'Test author',
    base: 'main',
    baseSha: 'abc',
    author: { id: 1, login: 'alice' },
    createdAt: '2026-11-23T00:00:00Z',
    updatedAt: '2026-11-23T00:00:00Z',
    status: 'draft',
    reviews: [],
    requests: [],
  };
}

function summary(number: number, head: string, base: string): PullRequestSummary {
  return { number, title: 't', url: '', head, base, draft: false, author: '', updatedAt: '' };
}

function client(open: PullRequestSummary[], refusal: GitHubRequestError): GitHubDraftsClient {
  const fail = () => Promise.reject(new Error('not used'));
  return {
    listOpenPullRequests: async () => open,
    createPullRequest: () => Promise.reject(refusal),
    branchExists: fail,
    defaultBranch: fail,
    branchSha: fail,
    createBranchAt: fail,
    deleteBranch: fail,
    pullState: fail,
    closePull: fail,
  };
}

const git = { projectDir: '/nowhere', runGit: () => '', authEnv: () => ({}) };
const repo = { owner: 'alice', name: 'wiki' };

describe('draft remote pull requests', () => {
  it('reuses the open pull request Forgejo already has for the draft branch', async () => {
    const refusal = new GitHubRequestError(409, 'pull request already exists for these targets');
    const remote = forgejoRemote(
      client([summary(1, 'other', 'main'), summary(2, 'draft/test-author', 'main')], refusal),
      repo,
      'https://forgejo.example',
      git,
    );
    expect(await remote.openReview(draft(), 'body')).toBe(2);
  });

  it('reuses the open pull request GitHub already has for the draft branch', async () => {
    const refusal = new GitHubRequestError(
      422,
      'Validation Failed — A pull request already exists',
    );
    const remote = gitHubRemote(
      client([summary(7, 'draft/test-author', 'main')], refusal),
      repo,
      'https://github.com',
      git,
    );
    expect(await remote.openReview(draft(), 'body')).toBe(7);
  });

  it('passes the refusal on when no open pull request matches', async () => {
    const refusal = new GitHubRequestError(403, 'forbidden');
    const remote = gitHubRemote(
      client([summary(7, 'draft/test-author', 'develop')], refusal),
      repo,
      'https://github.com',
      git,
    );
    await expect(remote.openReview(draft(), 'body')).rejects.toBe(refusal);
  });
});

describe('closing a draft whose pull request number was lost', () => {
  it('closes the open pull request for the draft branch before deleting the branch', async () => {
    const calls: string[] = [];
    const base = client(
      [summary(2, 'draft/test-author', 'main')],
      new GitHubRequestError(409, 'exists'),
    );
    const remote = forgejoRemote(
      {
        ...base,
        closePull: async (number) => {
          calls.push(`close ${number}`);
        },
        deleteBranch: async (branch) => {
          calls.push(`delete ${branch}`);
        },
      },
      repo,
      'https://forgejo.example',
      git,
    );
    await remote.close(draft());
    expect(calls).toEqual(['close 2', 'delete draft/test-author']);
  });
});

describe('gitHubRemote pullUrl', () => {
  const withPull: DraftRecord = { ...draft(), pull: 7 };

  it('links to the configured GitHub web address', () => {
    const remote = gitHubRemote({} as GitHubDraftsClient, repo, 'https://github.example.com', git);
    expect(remote.pullUrl(withPull)).toBe('https://github.example.com/alice/wiki/pull/7');
  });

  it('has no link before a pull request exists', () => {
    const remote = gitHubRemote({} as GitHubDraftsClient, repo, 'https://github.com', git);
    expect(remote.pullUrl(draft())).toBeUndefined();
  });
});
