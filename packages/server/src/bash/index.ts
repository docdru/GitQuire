import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
/*
 * UPSTREAM(just-bash@2.14.5): releases before 2.14.3 hardcode the POSIX separator
 * in the containment gate, rejecting backslash-separated Windows paths below
 * the root. Keep package.json at or above that containment floor.
 */
import { Bash, OverlayFs } from 'just-bash';
import { HiddenPathsFs } from './hidden-paths-fs.ts';

const EXEC_HIDDEN_DIRS: readonly string[] = ['.gitquire/local', '.ok/local'];
const EXEC_LOCAL_DATA_PARENTS: readonly string[] = ['.gitquire', '.ok'];

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

const PROJECT_MOUNT = '/home/user/project';

export type ErofsCheck = { blocked: false } | { blocked: true; target: string | null };

export function erofsTarget(source: unknown): ErofsCheck {
  const message = source instanceof Error ? source.message : String(source);
  if (!message.includes('EROFS: read-only file system')) return { blocked: false };
  for (const match of message.matchAll(/'([^']+)'/g)) {
    const raw = match[1];
    if (raw === '<path>') continue;
    const rel = raw.startsWith(`${PROJECT_MOUNT}/`) ? raw.slice(PROJECT_MOUNT.length + 1) : raw;
    const clean = rel.startsWith('./') ? rel.slice(2) : rel;
    if (clean !== '' && clean !== '.' && clean !== PROJECT_MOUNT)
      return { blocked: true, target: clean };
  }
  return { blocked: true, target: null };
}

export { shellEscape } from './shell-escape.ts';

interface ExecBashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class StdoutOverflowError extends Error {
  public readonly limitBytes: number;
  public readonly actualBytes: number;
  public readonly partial: ExecBashResult;
  constructor(limit: number, actual: number, partial: ExecBashResult) {
    super(`Output exceeded ${limit} byte buffer (got ${actual}); narrow the command`);
    this.name = 'StdoutOverflowError';
    this.limitBytes = limit;
    this.actualBytes = actual;
    this.partial = partial;
  }
}

export function createBashInstance(cwd: string, hidden: readonly string[] = []): Bash {
  if (!isAbsolute(cwd)) {
    throw new Error(`createBashInstance: cwd must be absolute (got: ${cwd})`);
  }
  const overlay = new OverlayFs({
    root: resolve(cwd),
    mountPoint: PROJECT_MOUNT,
    allowSymlinks: false,
    readOnly: true,
  });
  return new Bash({
    cwd: PROJECT_MOUNT,
    fs:
      hidden.length === 0
        ? overlay
        : new HiddenPathsFs(
            overlay,
            hidden.map((rel) => `${PROJECT_MOUNT}/${rel.replace(/\\/g, '/')}`),
          ),
  });
}

function folded(path: string): string {
  return resolve(path).toLowerCase();
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(folded(parent), folded(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function hiddenFromExec(projectDir: string, executionCwd: string): string[] | 'inside' {
  const project = realOrResolved(projectDir);
  const exec = realOrResolved(executionCwd);
  const hidden: string[] = [];
  for (const dir of EXEC_HIDDEN_DIRS) {
    const target = resolve(project, dir);
    if (isWithin(target, exec)) return 'inside';
    if (isWithin(exec, target)) hidden.push(relative(folded(exec), folded(target)));
  }
  return hidden;
}

export function isHiddenFromExec(projectDir: string, path: string): boolean {
  const target = resolve(projectDir, path);
  return EXEC_HIDDEN_DIRS.some((dir) => isWithin(resolve(projectDir, dir), target));
}

export function isLocalDataPath(projectDir: string, path: string): boolean {
  const project = realOrResolved(projectDir);
  const real = realOrResolved(resolve(projectDir, path));
  return EXEC_LOCAL_DATA_PARENTS.some((dir) => isWithin(resolve(project, dir), real));
}

export async function execBash(bash: Bash, command: string): Promise<ExecBashResult> {
  const result = await bash.exec(command);
  if (result.stdout.length > MAX_STDOUT_BYTES) {
    throw new StdoutOverflowError(MAX_STDOUT_BYTES, result.stdout.length, {
      stdout: result.stdout.slice(0, MAX_STDOUT_BYTES),
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}
