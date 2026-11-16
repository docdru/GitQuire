import { type RunGit, runGitSync } from './repo-bootstrap.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const DRAFT_SLUG_ENV = 'GITQUIRE_DRAFT';
export const DRAFT_TITLE_ENV = 'GITQUIRE_DRAFT_TITLE';
export const DRAFT_BASE_ENV = 'GITQUIRE_DRAFT_BASE';
const BRANCH_ENV = 'GITQUIRE_BRANCH';

export interface Workspace {
  kind: 'live' | 'draft';
  branch: string | null;
  draft: { slug: string; title: string; base: string | null } | null;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function checkedOutBranch(dir: string, runGit: RunGit): string | undefined {
  try {
    return nonEmpty(runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir));
  } catch {
    return undefined;
  }
}

export function resolveWorkspace(env: Env, dir: string, runGit: RunGit = runGitSync): Workspace {
  const branch = checkedOutBranch(dir, runGit) ?? nonEmpty(env[BRANCH_ENV]) ?? null;
  const slug = nonEmpty(env[DRAFT_SLUG_ENV]);
  if (slug === undefined) return { kind: 'live', branch, draft: null };
  return {
    kind: 'draft',
    branch,
    draft: {
      slug,
      title: nonEmpty(env[DRAFT_TITLE_ENV]) ?? slug,
      base: nonEmpty(env[DRAFT_BASE_ENV]) ?? null,
    },
  };
}

export function describeWorkspace(workspace: Workspace): string {
  const branch = workspace.branch === null ? 'no branch checked out' : `branch ${workspace.branch}`;
  if (workspace.draft === null) {
    return `You are working in the live wiki (${branch}). Changes you make here are saved for everyone right away.`;
  }
  const from = workspace.draft.base === null ? '' : `, started from ${workspace.draft.base}`;
  return `You are working in the draft "${workspace.draft.title}" (${branch}${from}), not in the live wiki. Changes you make stay in this draft until someone publishes it.`;
}
