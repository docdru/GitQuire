import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitHubDraftsClient } from '../github-pulls.ts';
import type { RunGit } from '../repo-bootstrap.ts';
import type { GitIdentity } from './git-ops.ts';
import type { DraftRecord } from './model.ts';

type Env = Readonly<Record<string, string>>;

export type PublishResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict'; message: string };

export interface DraftRemote {
  readonly kind: 'github' | 'git';
  headSha: (branch: string) => Promise<string | undefined>;
  createBranch: (branch: string, sha: string) => Promise<void>;
  deleteBranch: (branch: string) => Promise<void>;
  openReview: (draft: DraftRecord, body: string) => Promise<number | undefined>;
  publish: (draft: DraftRecord, title: string, who: GitIdentity) => Promise<PublishResult>;
  close: (draft: DraftRecord) => Promise<void>;
  closedElsewhere: (draft: DraftRecord) => Promise<'merged' | 'closed' | undefined>;
  pullUrl: (draft: DraftRecord) => string | undefined;
}

export function gitHubRemote(
  client: GitHubDraftsClient,
  repo: { owner: string; name: string },
): DraftRemote {
  async function ensurePull(draft: DraftRecord, body: string): Promise<number> {
    if (draft.pull !== undefined) return draft.pull;
    const pull = await client.createPullRequest({
      title: draft.title,
      body,
      head: draft.branch,
      base: draft.base,
    });
    return pull.number;
  }

  return {
    kind: 'github',
    headSha: (branch) => client.branchSha(branch),
    createBranch: (branch, sha) => client.createBranchAt(branch, sha),
    deleteBranch: (branch) => client.deleteBranch(branch),
    openReview: (draft, body) => ensurePull(draft, body),
    publish: async (draft, title) => {
      const number = await ensurePull(draft, `Published from GitQuire.`);
      draft.pull = number;
      const outcome = await client.mergePull(number, `${title} (#${number})`);
      if (!outcome.merged) return { ok: false, reason: 'conflict', message: outcome.message };
      await client.deleteBranch(draft.branch);
      return { ok: true, sha: outcome.sha };
    },
    close: async (draft) => {
      if (draft.pull !== undefined) await client.closePull(draft.pull);
      await client.deleteBranch(draft.branch);
    },
    closedElsewhere: async (draft) => {
      if (draft.pull !== undefined) {
        const state = await client.pullState(draft.pull);
        if (state.merged) return 'merged';
        if (state.state === 'closed') return 'closed';
        return undefined;
      }
      return (await client.branchSha(draft.branch)) === undefined ? 'closed' : undefined;
    },
    pullUrl: (draft) =>
      draft.pull === undefined
        ? undefined
        : `https://github.com/${repo.owner}/${repo.name}/pull/${draft.pull}`,
  };
}

export function plainGitRemote(
  projectDir: string,
  runGit: RunGit,
  authEnv: () => Env,
): DraftRemote {
  const originUrl = (): string => runGit(['remote', 'get-url', 'origin'], projectDir).trim();

  async function headSha(branch: string): Promise<string | undefined> {
    const line = runGit(
      ['ls-remote', 'origin', `refs/heads/${branch}`],
      projectDir,
      authEnv(),
    ).trim();
    const sha = line.split(/\s+/)[0];
    return sha === undefined || sha === '' ? undefined : sha;
  }

  return {
    kind: 'git',
    headSha,
    createBranch: async (branch, sha) => {
      runGit(['push', '--quiet', 'origin', `${sha}:refs/heads/${branch}`], projectDir, authEnv());
    },
    deleteBranch: async (branch) => {
      if ((await headSha(branch)) === undefined) return;
      runGit(['push', '--quiet', 'origin', `:refs/heads/${branch}`], projectDir, authEnv());
    },
    openReview: async () => undefined,
    publish: async (draft, title, who) => {
      const scratch = mkdtempSync(join(tmpdir(), 'gitquire-publish-'));
      try {
        runGit(
          ['clone', '--quiet', '--no-tags', '--branch', draft.base, originUrl(), scratch],
          tmpdir(),
          authEnv(),
        );
        runGit(
          [
            'fetch',
            '--quiet',
            'origin',
            `+refs/heads/${draft.branch}:refs/remotes/origin/${draft.branch}`,
          ],
          scratch,
          authEnv(),
        );
        try {
          runGit(['merge', '--squash', `refs/remotes/origin/${draft.branch}`], scratch);
        } catch {
          return {
            ok: false,
            reason: 'conflict',
            message: 'The live wiki changed in the same places.',
          };
        }
        runGit(
          [
            '-c',
            `user.name=${who.name}`,
            '-c',
            `user.email=${who.email}`,
            'commit',
            '--quiet',
            '--allow-empty',
            '-m',
            title,
          ],
          scratch,
        );
        runGit(['push', '--quiet', 'origin', `HEAD:refs/heads/${draft.base}`], scratch, authEnv());
        const sha = runGit(['rev-parse', 'HEAD'], scratch).trim();
        runGit(['push', '--quiet', 'origin', `:refs/heads/${draft.branch}`], scratch, authEnv());
        return { ok: true, sha };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    close: async (draft) => {
      if ((await headSha(draft.branch)) === undefined) return;
      runGit(['push', '--quiet', 'origin', `:refs/heads/${draft.branch}`], projectDir, authEnv());
    },
    closedElsewhere: async (draft) =>
      (await headSha(draft.branch)) === undefined ? 'closed' : undefined,
    pullUrl: () => undefined,
  };
}
