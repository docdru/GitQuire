import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';

type ExecutableFacts = {
  isExecutableFile: (path: string) => boolean;
};

export function probeRunningAsRoot(uid: number | undefined): boolean {
  return uid === 0;
}

export function findExecutable(
  command: string,
  path: string | undefined,
  { isExecutableFile }: ExecutableFacts,
): boolean {
  return (path ?? '/usr/bin:/bin')
    .split(':')
    .some((directory) => isExecutableFile(posix.join(directory, command)));
}

export function probePid1Reaps(comm: string | undefined): boolean {
  return comm?.trim() !== 'sleep';
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pid1Comm(): string | undefined {
  try {
    return readFileSync('/proc/1/comm', 'utf8');
  } catch {
    return undefined;
  }
}

export const executableFacts: ExecutableFacts = {
  isExecutableFile,
};

export const runningAsRoot = probeRunningAsRoot(process.getuid?.());
export const hasLsof = findExecutable('lsof', process.env.PATH, executableFacts);
export const hasUvx = findExecutable('uvx', process.env.PATH, executableFacts);
export const pid1Reaps = probePid1Reaps(pid1Comm());
