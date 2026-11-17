import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tracedMkdirSync } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';

export type ConfigFileWatcherUnsubscribe = () => Promise<void>;

export type ConfigFileWatcher = ConfigFileWatcherUnsubscribe & {
  readonly resync: () => void;
  readonly recheck: () => Promise<boolean>;
};

function readOrNull(path: string, log: ReturnType<typeof getLogger>): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') {
      log.warn({ err, path }, 'config file baseline read failed; treating it as absent');
    }
    return null;
  }
}

export async function startConfigFileWatcher(
  absPath: string,
  onChange: (content: string) => void | Promise<void>,
): Promise<ConfigFileWatcher> {
  const log = getLogger('config-file-watcher');

  const watchDir = dirname(absPath);
  try {
    tracedMkdirSync(watchDir, { recursive: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'EEXIST') {
      log.warn({ err, watchDir }, 'failed to create watch directory; watcher may be inert');
    }
  }

  let lastContent = readOrNull(absPath, log);
  const handlePath = async (path: string, logMissing = true): Promise<boolean> => {
    if (path !== absPath) return false;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        if (logMissing) {
          log.debug({ path }, 'config file disappeared between event and read; dropping');
        }
        return false;
      }
      log.warn({ err, path }, 'config file read failed; dropping event');
      return false;
    }
    if (content === lastContent) return false;
    lastContent = content;
    try {
      await onChange(content);
    } catch (err) {
      log.warn({ err, path }, 'config file change handler threw');
    }
    return true;
  };

  const stop = async (): Promise<void> => {};
  void handlePath(absPath, false);
  return Object.assign(() => stop(), {
    resync: () => {
      lastContent = readOrNull(absPath, log);
    },
    recheck: () => handlePath(absPath, false),
  });
}

export async function startMultiPathConfigFileWatcher(
  absPaths: ReadonlyArray<string>,
  onChange: (path: string, content: string) => void | Promise<void>,
): Promise<ConfigFileWatcher> {
  if (absPaths.length === 0) {
    throw new Error('startMultiPathConfigFileWatcher requires at least one absolute path');
  }
  const log = getLogger('config-file-watcher');

  const watchedPaths = new Set(absPaths);
  const watchDirs = Array.from(new Set(Array.from(watchedPaths, (p) => dirname(p))));

  for (const dir of watchDirs) {
    try {
      tracedMkdirSync(dir, { recursive: true });
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'EEXIST') {
        log.warn({ err, dir }, 'failed to create watch directory; watcher may be inert');
      }
    }
  }

  const lastContent = new Map<string, string | null>();
  const resync = (): void => {
    for (const path of watchedPaths) lastContent.set(path, readOrNull(path, log));
  };
  resync();

  const handlePath = async (path: string, logMissing = true): Promise<boolean> => {
    if (!watchedPaths.has(path)) return false;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT') {
        log.warn({ err, path }, 'config file read failed; dropping event');
        return false;
      }
      if (lastContent.get(path) === null) return false;
      if (logMissing) log.debug({ path }, 'config file was removed; taking it in as empty');
      content = '';
      lastContent.set(path, null);
      try {
        await onChange(path, content);
      } catch (handlerErr) {
        log.warn({ err: handlerErr, path }, 'config file change handler threw');
      }
      return true;
    }
    if (content === lastContent.get(path)) return false;
    lastContent.set(path, content);
    try {
      await onChange(path, content);
    } catch (err) {
      log.warn({ err, path }, 'config file change handler threw');
    }
    return true;
  };

  const stop = async (): Promise<void> => {};
  const recheck = async (): Promise<boolean> => {
    let changed = false;
    for (const path of watchedPaths) {
      if (await handlePath(path, false)) changed = true;
    }
    return changed;
  };
  void recheck();
  return Object.assign(() => stop(), { resync, recheck });
}
