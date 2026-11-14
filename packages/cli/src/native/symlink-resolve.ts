import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { debugConfigFailure } from '../utils/debug-config-failure.ts';

export interface SymlinkWritePaths {
  readPath: string | null;
  writePath: string;
}

export function resolveHarnessWritePaths(path: string): SymlinkWritePaths {
  let current = path;
  const visited = new Set<string>();

  for (;;) {
    let isSymlink: boolean;
    try {
      isSymlink = lstatSync(current).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { readPath: current, writePath: current };
      }
      return { readPath: null, writePath: path };
    }

    if (!isSymlink) return { readPath: current, writePath: current };

    if (visited.has(current)) return { readPath: null, writePath: path };
    visited.add(current);

    let target: string;
    try {
      target = readlinkSync(current);
    } catch (err) {
      debugConfigFailure('readlinkSync threw during symlink walk', err);
      return { readPath: null, writePath: path };
    }
    current = isAbsolute(target) ? target : join(dirname(current), target);
  }
}
