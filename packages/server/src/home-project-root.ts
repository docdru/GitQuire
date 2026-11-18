import { realpathSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { currentCliCommandName } from '@gitquire/core';

export class HomeProjectRootError extends Error {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(
      `Refusing to set up a GitQuire project in your home directory (${projectRoot}).\n` +
        `  A project here would run 'git init' in your home directory and write project config\n` +
        `  and skills into your editors' user-global directories (~/.cursor, ~/.codex, ~/.claude).\n` +
        `  Make a folder for this project, then run '${currentCliCommandName()} init' inside it.`,
    );
    this.name = 'HomeProjectRootError';
    this.projectRoot = projectRoot;
  }
}

export class FilesystemRootProjectError extends Error {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(
      `Refusing to set up a GitQuire project at the filesystem root (${projectRoot}).\n` +
        `  A project here would scan every file on the system and run 'git init' at its root.\n` +
        `  Make a folder for this project, then run '${currentCliCommandName()} init' inside it.`,
    );
    this.name = 'FilesystemRootProjectError';
    this.projectRoot = projectRoot;
  }
}

export function canonicalizeForCompare(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

export function isHomeDir(dir: string, home: string = nodeHomedir()): boolean {
  return canonicalizeForCompare(resolve(dir)) === canonicalizeForCompare(home);
}

export function isFilesystemRoot(dir: string): boolean {
  const abs = canonicalizeForCompare(resolve(dir));
  return dirname(abs) === abs;
}

export function assertSafeProjectRoot(dir: string, home?: string): void {
  if (isHomeDir(dir, home)) throw new HomeProjectRootError(resolve(dir));
  if (isFilesystemRoot(dir)) throw new FilesystemRootProjectError(resolve(dir));
}
