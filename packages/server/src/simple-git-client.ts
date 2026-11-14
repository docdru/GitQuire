import { simpleGit as createSimpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';

export const GIT_ALLOWED_ENVIRONMENT: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_TERMINAL_PROMPT',
  'GIT_MERGE_AUTOEDIT',
  'GIT_OPTIONAL_LOCKS',
];

function withDefaults(options: Partial<SimpleGitOptions>): Partial<SimpleGitOptions> {
  const allowEnvironment = [
    ...new Set([...GIT_ALLOWED_ENVIRONMENT, ...(options.allowEnvironment ?? [])]),
  ];
  return { ...options, allowEnvironment };
}

export function simpleGit(options?: Partial<SimpleGitOptions>): SimpleGit;
export function simpleGit(baseDir: string, options?: Partial<SimpleGitOptions>): SimpleGit;
export function simpleGit(
  baseDirOrOptions?: string | Partial<SimpleGitOptions>,
  options?: Partial<SimpleGitOptions>,
): SimpleGit {
  if (typeof baseDirOrOptions === 'string') {
    return createSimpleGit(withDefaults({ ...options, baseDir: baseDirOrOptions }));
  }
  return createSimpleGit(withDefaults(baseDirOrOptions ?? {}));
}

export type { SimpleGit, SimpleGitOptions } from 'simple-git';
