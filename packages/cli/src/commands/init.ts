import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { inspect } from 'node:util';
import { currentCliCommandName } from '@gitquire/core';
import {
  ensureProjectGit,
  FilesystemRootProjectError,
  GitNotAvailableError,
  GitProbeTimeoutError,
  GitTooOldError,
  HomeProjectRootError,
  initContent,
  isFilesystemRoot,
  ProjectGitInitError,
  writeRootGitignoreForNewRepo,
} from '@gitquire/server';
import select from '@inquirer/select';
import { Command, Option } from 'commander';
import { CONFIG_FILENAME, OK_DIR } from '../constants.ts';
import { formatPreviewBlock, type PreviewResult } from '../content/preview.ts';
import {
  isHomeDir,
  type ResolveProjectRootResult,
  resolveProjectRoot,
} from '../integrations/resolve-project-root.ts';
import {
  addOkPathsToGitExclude,
  type ExcludeWriteResult,
  getOkArtifactPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
  type SharingMode,
  type TrackedRefusal,
} from '../sharing/git-exclude.ts';
import { accent, info, success, warning } from '../ui/colors.ts';

async function promptSharingMode(
  defaultMode: 'shared' | 'local-only',
): Promise<'shared' | 'local-only'> {
  return select<'shared' | 'local-only'>({
    message: 'How do you want to handle GitQuire config files (.ok/)?',
    default: defaultMode,
    choices: [
      {
        name: 'Share with my team (commit alongside content)',
        value: 'shared',
        description: 'OK config gets committed alongside your project content.',
      },
      {
        name: 'Local only (keep out of git via .git/info/exclude)',
        value: 'local-only',
        description: `OK config stays on this machine only; teammates do not see it. Safe escape hatch via \`${currentCliCommandName()} config-sharing share\`.`,
      },
    ],
  });
}

export async function resolveSharingMode(opts: {
  sharing?: 'shared' | 'local-only';
  projectRoot: string;
  isTTY?: boolean;
  freshProject?: boolean;
  promptFn?: (defaultMode: 'shared' | 'local-only') => Promise<'shared' | 'local-only'>;
}): Promise<'shared' | 'local-only'> {
  if (opts.sharing !== undefined) return opts.sharing;
  const current = readSharingMode(opts.projectRoot);
  const seed: 'shared' | 'local-only' =
    current === 'local-only' || opts.freshProject === true ? 'local-only' : 'shared';
  const tty = opts.isTTY ?? process.stdout.isTTY;
  if (!tty) return seed;
  const prompt = opts.promptFn ?? promptSharingMode;
  return prompt(seed);
}

export class ContentDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentDirError';
  }
}

export function resolveRequestedContentDir(
  input: string,
  projectRoot: string,
  cwd: string,
): string {
  const abs = resolve(cwd, input);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ContentDirError(`--content-dir path does not exist: ${abs}`);
    }
    throw new ContentDirError(
      `--content-dir path is not accessible (${code ?? 'unknown error'}): ${abs}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new ContentDirError(`--content-dir must be a directory: ${abs}`);
  }
  const canonRoot = safeRealpath(projectRoot);
  const canonAbs = safeRealpath(abs);
  const rel = relative(canonRoot, canonAbs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ContentDirError(
      `--content-dir must be inside the project root (${projectRoot}); got ${abs}`,
    );
  }
  return rel === '' ? '.' : rel;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export type SharingOutcome =
  | {
      kind: 'applied';
      mode: SharingMode;
      action: 'added' | 'removed' | 'cleaned' | 'noop';
      appended: string[];
      alreadyPresent: string[];
      removed: string[];
    }
  | { kind: 'refused-tracked'; tracked: string[]; remediation: string }
  | {
      kind: 'no-exclude';
      reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible';
      localOnlyRequested: boolean;
    };

export async function applySharingMode(opts: {
  projectRoot: string;
  desiredMode: 'shared' | 'local-only';
  explicitFlag: 'shared' | 'local-only' | undefined;
}): Promise<SharingOutcome> {
  const { projectRoot, desiredMode, explicitFlag } = opts;
  const current = readSharingMode(projectRoot);

  if (current === 'no-git') {
    return {
      kind: 'no-exclude',
      reason: 'no-git',
      localOnlyRequested: explicitFlag === 'local-only',
    };
  }

  const paths = getOkArtifactPaths(projectRoot);
  if (desiredMode === 'local-only') {
    const result = addOkPathsToGitExclude(projectRoot, paths);
    if (result.kind === 'refused-tracked') {
      const refusal: TrackedRefusal = result;
      return {
        kind: 'refused-tracked',
        tracked: refusal.tracked,
        remediation: refusal.remediation,
      };
    }
    if (result.kind === 'no-exclude') {
      return {
        kind: 'no-exclude',
        reason: result.reason,
        localOnlyRequested: explicitFlag === 'local-only',
      };
    }
    return summarizeApplied(projectRoot, result, 'add');
  }

  if (current === 'shared') {
    return {
      kind: 'applied',
      mode: 'shared',
      action: 'noop',
      appended: [],
      alreadyPresent: [],
      removed: [],
    };
  }
  const result = removeOkPathsFromGitExclude(projectRoot, paths);
  if (result.kind === 'no-exclude') {
    return {
      kind: 'no-exclude',
      reason: result.reason,
      localOnlyRequested: false,
    };
  }
  return summarizeApplied(projectRoot, result, 'remove');
}

function summarizeApplied(
  projectRoot: string,
  result: Extract<ExcludeWriteResult, { kind: 'updated' }>,
  direction: 'add' | 'remove',
): Extract<SharingOutcome, { kind: 'applied' }> {
  const mode = readSharingMode(projectRoot);
  if (direction === 'add') {
    return {
      kind: 'applied',
      mode,
      action: result.appended.length > 0 ? 'added' : result.removed.length > 0 ? 'cleaned' : 'noop',
      appended: result.appended,
      alreadyPresent: result.alreadyPresent,
      removed: result.removed,
    };
  }
  return {
    kind: 'applied',
    mode,
    action: 'removed',
    appended: [],
    alreadyPresent: [],
    removed: result.removed,
  };
}

function redirectStdoutConsoleToStderr(): () => void {
  const orig = { log: console.log, info: console.info, debug: console.debug };
  const toErr = (...args: unknown[]): void => {
    process.stderr.write(
      `${args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ')}\n`,
    );
  };
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
  return () => {
    console.log = orig.log;
    console.info = orig.info;
    console.debug = orig.debug;
  };
}

export function formatSharingOutcome(outcome: SharingOutcome, cwd: string): string[] {
  const lines: string[] = [];
  switch (outcome.kind) {
    case 'applied':
      lines.push(accent('Sharing mode:'));
      if (outcome.mode === 'local-only') {
        if (outcome.action === 'added') {
          lines.push(
            `  ${success('local-only')} — appended ${outcome.appended.length} path(s) to ${accent(`${cwd}/.git/info/exclude`)} (per-clone, not committed).`,
          );
          if (outcome.removed.length > 0) {
            lines.push(
              `    cleared ${outcome.removed.length} stale entry(s) left by an older version: ${outcome.removed.join(', ')}.`,
            );
          }
        } else if (outcome.action === 'cleaned') {
          lines.push(
            `  ${success('local-only')} — already excluded; cleared ${outcome.removed.length} stale entry(s) left by an older version: ${outcome.removed.join(', ')}.`,
          );
        } else if (outcome.action === 'noop' && outcome.alreadyPresent.length > 0) {
          lines.push(`  ${success('local-only')} — already excluded; nothing to do.`);
        } else {
          lines.push(`  ${success('local-only')}`);
        }
      } else {
        if (outcome.action === 'removed') {
          lines.push(
            `  ${success('shared')} — removed OK paths from ${accent(`${cwd}/.git/info/exclude`)}; commit the files to share with teammates.`,
          );
        } else {
          lines.push(`  ${success('shared')} — OK config will be committed alongside content.`);
        }
      }
      return lines;
    case 'refused-tracked':
      lines.push(warning('Sharing mode: switch to local-only deferred'));
      for (const raw of outcome.remediation.split('\n')) {
        lines.push(raw.length > 0 ? `  ${raw}` : '');
      }
      lines.push(
        `  Re-run ${info(`${currentCliCommandName()} config-sharing unshare`)} after resolving to complete the switch.`,
      );
      return lines;
    case 'no-exclude': {
      if (outcome.localOnlyRequested) {
        lines.push(
          warning('Sharing mode: --local-only requested but no git repo found — option ignored'),
        );
        lines.push(
          `  Run ${info('git init')} and then ${info(`${currentCliCommandName()} config-sharing unshare`)}.`,
        );
      } else if (outcome.reason === 'no-git') {
        return [];
      } else {
        lines.push(warning(`Sharing mode unavailable: ${outcome.reason}.`));
      }
      return lines;
    }
  }
}

interface InitCommandOptions {
  cwd?: string;
  projectRootMode?: 'discover' | 'cwd';
  home?: string;
  isTTY?: boolean;
  sharing?: 'shared' | 'local-only';
  sharingPromptFn?: (defaultMode: 'shared' | 'local-only') => Promise<'shared' | 'local-only'>;
  contentDir?: string;
}

interface InitCommandResult {
  projectRoot: string;
  contentCreated: string[];
  contentUpdated: string[];
  contentSkipped: string[];
  preview?: PreviewResult;
  didGitInit: boolean;
  rootGitignoreCreated: boolean;
  gitRootPromoted: boolean;
  promotedFromDir?: string;
  contentDir?: string;
  contentDirRequested?: string;
  contentScaffoldFailed: boolean;
  contentError?: string;
  previewWarning?: string;
  sharing: SharingOutcome;
}

export { FilesystemRootProjectError, HomeProjectRootError };

export async function runInit(options: InitCommandOptions = {}): Promise<InitCommandResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const resolution =
    options.projectRootMode === 'cwd'
      ? ({
          projectRoot: cwd,
          defaultContentDir: '.',
          ancestorPromoted: false,
          gitRootPromoted: false,
        } satisfies ResolveProjectRootResult)
      : resolveProjectRoot(cwd, { homeDir: options.home });
  const projectRoot = resolution.projectRoot;
  if (isHomeDir(projectRoot, options.home ?? homedir())) {
    throw new HomeProjectRootError(projectRoot);
  }
  if (isFilesystemRoot(projectRoot)) {
    throw new FilesystemRootProjectError(projectRoot);
  }
  const willScaffold = !existsSync(join(projectRoot, OK_DIR));
  const promotedFromDir = resolution.gitRootPromoted ? relative(projectRoot, cwd) : undefined;
  const contentDirScope =
    options.contentDir !== undefined
      ? resolveRequestedContentDir(options.contentDir, projectRoot, cwd)
      : resolution.defaultContentDir;
  if (resolution.ancestorPromoted) {
    console.log(`[ok] Opened existing project at ${projectRoot}`);
  } else if (resolution.gitRootPromoted && willScaffold && contentDirScope === '.') {
    process.stderr.write(
      `${warning(`[ok] Content scope promoted to the git repo root: ${projectRoot}`)}\n` +
        `      Ran in ${promotedFromDir}/, but .ok/ lives at the git root (one .ok/ per git repo),\n` +
        `      so the whole repo is now the content scope. To narrow it, re-run with\n` +
        `      \`${currentCliCommandName()} init --content-dir .\`, or set content.dir: ${promotedFromDir} in ${OK_DIR}/config.yml.\n`,
    );
  }

  const gitResult = await ensureProjectGit(projectRoot);

  let contentResult: ReturnType<typeof initContent>;
  try {
    contentResult = initContent(projectRoot, { contentDir: contentDirScope });
  } catch (err) {
    return {
      projectRoot,
      contentCreated: [],
      contentUpdated: [],
      contentSkipped: [],
      didGitInit: gitResult.didInit,
      rootGitignoreCreated: false,
      gitRootPromoted: resolution.gitRootPromoted,
      promotedFromDir,
      contentDirRequested: options.contentDir,
      contentScaffoldFailed: true,
      contentError: `Content scaffolding failed: ${err instanceof Error ? err.message : String(err)}`,
      sharing: { kind: 'no-exclude', reason: 'no-git', localOnlyRequested: false },
    };
  }

  const configCreated = contentResult.created.includes(CONFIG_FILENAME);

  let rootGitignoreCreated = false;
  if (gitResult.didInit) {
    try {
      rootGitignoreCreated = writeRootGitignoreForNewRepo(projectRoot) === 'created';
    } catch (err) {
      console.warn(
        `[ok] Skipping .gitignore seed at ${projectRoot}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const desiredMode = await resolveSharingMode({
    sharing: options.sharing,
    projectRoot,
    isTTY: options.isTTY,
    freshProject: willScaffold,
    promptFn: options.sharingPromptFn,
  });
  const sharing = await applySharingMode({
    projectRoot,
    desiredMode,
    explicitFlag: options.sharing,
  });

  return {
    projectRoot,
    contentCreated: contentResult.created,
    contentUpdated: contentResult.updated,
    contentSkipped: contentResult.skipped,
    didGitInit: gitResult.didInit,
    rootGitignoreCreated,
    gitRootPromoted: resolution.gitRootPromoted,
    promotedFromDir,
    contentDir: configCreated ? contentDirScope : undefined,
    contentDirRequested: options.contentDir,
    contentScaffoldFailed: false,
    sharing,
  };
}

export function formatInitResult(result: InitCommandResult, cwd: string): string {
  const lines: string[] = [];
  if (result.didGitInit) {
    lines.push(`Initialized git repo at ${cwd}/.git/`);
  }
  if (result.rootGitignoreCreated) {
    lines.push(`Seeded .gitignore at ${cwd}/.gitignore (.DS_Store)`);
  }

  const okDir = join(cwd, OK_DIR);
  if (result.contentError) {
    lines.push(warning(result.contentError));
  } else if (result.contentCreated.length > 0 || result.contentUpdated.length > 0) {
    lines.push(accent(`Content scaffolded at ${okDir}/`));
    if (result.contentCreated.length > 0) {
      lines.push(`  Created: ${result.contentCreated.join(', ')}`);
    }
    if (result.contentUpdated.length > 0) {
      lines.push(`  Updated: ${result.contentUpdated.join(', ')}`);
    }
  } else {
    lines.push(accent(`Content already present at ${okDir}/`));
  }
  if (result.contentSkipped.length > 0) {
    lines.push(`  Skipped (already exist): ${result.contentSkipped.join(', ')}`);
  }

  if (
    result.contentDirRequested !== undefined &&
    result.contentDir === undefined &&
    !result.contentScaffoldFailed
  ) {
    lines.push('');
    lines.push(
      warning(
        `⚠ --content-dir ${result.contentDirRequested} ignored — ${OK_DIR}/config.yml already exists`,
      ),
    );
    lines.push(`  Edit ${OK_DIR}/config.yml → content.dir directly to change the content scope.`);
  } else if (result.contentDir !== undefined && result.contentDir !== '.') {
    lines.push('');
    lines.push(`Content scope set to ${result.contentDir}/ (content.dir in ${OK_DIR}/config.yml).`);
  } else if (
    result.gitRootPromoted &&
    result.contentDir === '.' &&
    result.contentDirRequested === undefined
  ) {
    lines.push('');
    lines.push(warning('⚠ Content scope promoted to the git repo root'));
    lines.push(
      `  .ok/ was initialized at ${cwd} because it contains a .git folder (one .ok/ per git repo),`,
    );
    lines.push(
      `  not the sub-folder you ran \`${currentCliCommandName()} init\` in${result.promotedFromDir ? ` (${result.promotedFromDir})` : ''}. The whole repo is now the content scope.`,
    );
    if (result.promotedFromDir) {
      lines.push(
        `  To scope to just that sub-folder, re-run \`${currentCliCommandName()} init --content-dir .\` from there, or set`,
      );
      lines.push(`  content.dir: ${result.promotedFromDir} in ${OK_DIR}/config.yml.`);
    }
  }

  if (result.preview) {
    lines.push('');
    lines.push(formatPreviewBlock(result.preview, cwd));
  } else if (result.previewWarning) {
    lines.push('');
    lines.push(`Content preview unavailable: ${result.previewWarning}`);
  }

  const sharingLines = formatSharingOutcome(result.sharing, cwd);
  if (sharingLines.length > 0) {
    lines.push('');
    lines.push(...sharingLines);
  }

  if (!result.contentScaffoldFailed) {
    lines.push('');
    lines.push(
      `${accent('Next steps:')} run ${info(`${currentCliCommandName()} start`)} and open the editor URL it prints.`,
    );
  }

  return lines.join('\n');
}

export interface InitJsonSummary {
  projectRoot: string;
  gitRootPromoted: boolean;
  promotedFromDir: string | null;
  contentDir: string;
  contentDirRequested: string | null;
  contentDirApplied: boolean;
  contentFileCount: number | null;
  previewError: string | null;
  didGitInit: boolean;
}

export function buildInitJsonSummary(
  result: InitCommandResult,
  opts: { contentDir: string; contentFileCount: number | null },
): InitJsonSummary {
  return {
    projectRoot: result.projectRoot,
    gitRootPromoted: result.gitRootPromoted,
    promotedFromDir: result.promotedFromDir ?? null,
    contentDir: opts.contentDir,
    contentDirRequested: result.contentDirRequested ?? null,
    contentDirApplied: result.contentDir !== undefined,
    contentFileCount: opts.contentFileCount,
    previewError: result.previewWarning ?? null,
    didGitInit: result.didGitInit,
  };
}

export function initCommand(): Command {
  return new Command('init')
    .description(`Scaffold ${OK_DIR}/ in the current directory`)
    .option(
      '--content-dir <dir>',
      `Limit content to <dir> instead of the whole project. <dir> is interpreted relative to your current directory (e.g. "." = the folder you run the command in), then saved to ${OK_DIR}/config.yml as content.dir.`,
    )
    .option('--json', 'Emit a structured JSON summary to stdout (diagnostics stay on stderr)')
    .addOption(new Option('--no-mcp').hideHelp())
    .addOption(new Option('--no-skills').hideHelp())
    .addOption(
      new Option(
        '--shared',
        'Commit OK config alongside content (the default for fresh repos)',
      ).conflicts('localOnly'),
    )
    .addOption(
      new Option(
        '--local-only',
        'Keep OK config out of git via .git/info/exclude (per-clone, not committed)',
      ).conflicts('shared'),
    )
    .action(
      async (opts: {
        shared?: boolean;
        localOnly?: boolean;
        contentDir?: string;
        json?: boolean;
      }) => {
        const cwd = process.cwd();
        const sharing: 'shared' | 'local-only' | undefined = opts.shared
          ? 'shared'
          : opts.localOnly
            ? 'local-only'
            : undefined;
        const restoreConsole = opts.json ? redirectStdoutConsoleToStderr() : null;
        try {
          let result: InitCommandResult;
          try {
            result = await runInit({ cwd, sharing, contentDir: opts.contentDir });
          } catch (err) {
            if (
              err instanceof ContentDirError ||
              err instanceof HomeProjectRootError ||
              err instanceof FilesystemRootProjectError
            ) {
              process.stderr.write(`${err.message}\n`);
              process.exitCode = 64;
              return;
            }
            if (
              err instanceof GitNotAvailableError ||
              err instanceof GitProbeTimeoutError ||
              err instanceof GitTooOldError
            ) {
              process.stderr.write(`${err.message}\n`);
              process.exitCode = 78;
              return;
            }
            if (err instanceof ProjectGitInitError) {
              process.stderr.write(
                "GitQuire could not initialize a git repo for this project. Re-run, or run 'git init' yourself in the project folder.\n",
              );
              if (err.stderr) process.stderr.write(`${err.stderr.trim()}\n`);
              process.exitCode = 1;
              return;
            }
            throw err;
          }

          let effectiveContentDir = result.contentDir ?? '.';
          let contentFileCount: number | null = null;
          const { loadConfig } = await import('../config/loader.ts');
          const { resolveContentDir } = await import('@gitquire/server');
          let config: Awaited<ReturnType<typeof loadConfig>>['config'] | undefined;
          try {
            config = loadConfig(result.projectRoot).config;
            effectiveContentDir = config.content.dir;
          } catch (e) {
            result.previewWarning = e instanceof Error ? e.message : String(e);
          }
          if (config) {
            try {
              const { previewContent } = await import('../content/preview.ts');
              const contentDir = resolveContentDir(config, result.projectRoot);
              result.preview = previewContent({
                projectDir: result.projectRoot,
                contentDir,
              });
              contentFileCount = result.preview.totalCount;
            } catch (e) {
              result.previewWarning = e instanceof Error ? e.message : String(e);
            }
          }

          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(
                buildInitJsonSummary(result, { contentDir: effectiveContentDir, contentFileCount }),
                null,
                2,
              )}\n`,
            );
          } else {
            process.stdout.write(`${formatInitResult(result, result.projectRoot)}\n`);
          }

          if (result.contentScaffoldFailed) process.exitCode = 1;
        } finally {
          restoreConsole?.();
        }
      },
    );
}
