import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_WRITER } from '../../shadow-repo.ts';
import type { GitHubDraftsClient } from '../github-pulls.ts';
import type { RunGit } from '../repo-bootstrap.ts';
import type { GitIdentity } from './git-ops.ts';
import type { DraftRecord } from './model.ts';

type Env = Readonly<Record<string, string>>;

type PublishResult = { ok: true; sha: string } | { ok: false; reason: 'conflict'; message: string };

export interface DraftRemote {
  readonly kind: 'github' | 'forgejo' | 'git';
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
  webUrl: string,
  git: GitAccess,
): DraftRemote {
  async function ensurePull(draft: DraftRecord, body: string): Promise<number> {
    if (draft.pull !== undefined) return draft.pull;
    try {
      const pull = await client.createPullRequest({
        title: draft.title,
        body,
        head: draft.branch,
        base: draft.base,
      });
      return pull.number;
    } catch (err) {
      const open = await openPullFor(draft).catch(() => undefined);
      if (open === undefined) throw err;
      return open;
    }
  }

  async function openPullFor(draft: DraftRecord): Promise<number | undefined> {
    const pulls = await client.listOpenPullRequests();
    return pulls.find((pull) => pull.head === draft.branch && pull.base === draft.base)?.number;
  }

  return {
    kind: 'github',
    headSha: (branch) => client.branchSha(branch),
    createBranch: (branch, sha) => client.createBranchAt(branch, sha),
    deleteBranch: (branch) => client.deleteBranch(branch),
    openReview: (draft, body) => ensurePull(draft, body),
    publish: async (draft, title, who) => {
      const number = await ensurePull(draft, `Published from GitQuire.`);
      draft.pull = number;
      const result = squashPublish(git, draft, `${title} (#${number})`, who);
      if (!result.ok) return result;
      await client.closePull(number);
      await client.deleteBranch(draft.branch);
      return result;
    },
    close: async (draft) => {
      const pull = draft.pull ?? (await openPullFor(draft).catch(() => undefined));
      if (pull !== undefined) await client.closePull(pull);
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
        : `${webUrl}/${repo.owner}/${repo.name}/pull/${draft.pull}`,
  };
}

export function forgejoRemote(
  client: GitHubDraftsClient,
  repo: { owner: string; name: string },
  webUrl: string,
  git: GitAccess,
): DraftRemote {
  return {
    ...gitHubRemote(client, repo, webUrl, git),
    kind: 'forgejo',
    pullUrl: (draft) =>
      draft.pull === undefined
        ? undefined
        : `${webUrl}/${repo.owner}/${repo.name}/pulls/${draft.pull}`,
  };
}

interface GitAccess {
  projectDir: string;
  runGit: RunGit;
  authEnv: () => Env;
}

const AUTHOR_LINE = /^(.+?) <([^<>\s]+@[^<>\s]+)>$/;
const SYSTEM_DOMAIN = SERVICE_WRITER.email.slice(SERVICE_WRITER.email.indexOf('@')).toLowerCase();

function draftCoAuthors(log: string, publisher: GitIdentity): GitIdentity[] {
  const seen = new Set([publisher.email.toLowerCase()]);
  const authors: GitIdentity[] = [];
  for (const line of log.split('\n')) {
    const match = AUTHOR_LINE.exec(line.trim());
    if (match === null) continue;
    const [, name, email] = match;
    if (name === undefined || email === undefined || email.toLowerCase().endsWith(SYSTEM_DOMAIN))
      continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push({ name, email });
  }
  return authors.reverse();
}

function publishMessage(title: string, coAuthors: readonly GitIdentity[]): string {
  if (coAuthors.length === 0) return title;
  const trailers = coAuthors.map((author) => `Co-authored-by: ${author.name} <${author.email}>`);
  return `${title}\n\n${trailers.join('\n')}`;
}

function squashPublish(
  git: GitAccess,
  draft: DraftRecord,
  title: string,
  who: GitIdentity,
): PublishResult {
  const { runGit, authEnv } = git;
  const originUrl = runGit(['remote', 'get-url', 'origin'], git.projectDir).trim();
  const scratch = mkdtempSync(join(tmpdir(), 'gitquire-publish-'));
  try {
    runGit(
      ['clone', '--quiet', '--no-tags', '--branch', draft.base, originUrl, scratch],
      tmpdir(),
      authEnv(),
    );
    const drafted = `refs/remotes/origin/${draft.branch}`;
    runGit(
      ['fetch', '--quiet', 'origin', `+refs/heads/${draft.branch}:${drafted}`],
      scratch,
      authEnv(),
    );
    const log = runGit(
      ['log', '--format=%an <%ae>%n%(trailers:key=Co-authored-by,valueonly)', `HEAD..${drafted}`],
      scratch,
    );
    try {
      runGit(['merge', '--squash', drafted], scratch);
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
        publishMessage(title, draftCoAuthors(log, who)),
      ],
      scratch,
    );
    runGit(['push', '--quiet', 'origin', `HEAD:refs/heads/${draft.base}`], scratch, authEnv());
    return { ok: true, sha: runGit(['rev-parse', 'HEAD'], scratch).trim() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function plainGitRemote(
  projectDir: string,
  runGit: RunGit,
  authEnv: () => Env,
): DraftRemote {
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
      const result = squashPublish({ projectDir, runGit, authEnv }, draft, title, who);
      if (result.ok) {
        runGit(['push', '--quiet', 'origin', `:refs/heads/${draft.branch}`], projectDir, authEnv());
      }
      return result;
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
