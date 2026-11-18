import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { LOCAL_DIR } from '@gitquire/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  legacyServerLock,
  lockWrittenByRunningProcess,
  type OwnedProcess,
  startOwnedProcess,
  stopOwnedProcess,
} from '../../../test-support/owned-process.test-helper.ts';
import { createTempDirFactory } from '../../../test-support/temp-dir.test-helper.ts';
import { getMachineId } from './machine-id.ts';
import {
  acquireProcessLock,
  type LockName,
  lockFilePath,
  ProcessLockCollisionError,
  type ProcessLockMetadata,
} from './process-lock.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const LOCK_NAME: LockName = 'server';
const tempDir = createTempDirFactory(afterEach);
const owned: OwnedProcess[] = [];

let lockDir: string;
let lockPath: string;

beforeEach(() => {
  lockDir = resolve(tempDir('ok-process-lock-acquire-fs-'), '.gitquire', LOCAL_DIR);
  lockPath = lockFilePath(lockDir, LOCK_NAME);
  mkdirSync(lockDir, { recursive: true });
});

afterEach(async () => {
  vi.mocked(readFileSync).mockImplementation(actualFs.readFileSync);
  vi.mocked(unlinkSync).mockImplementation(actualFs.unlinkSync);
  for (const holder of owned.splice(0)) await stopOwnedProcess(holder);
});

function errnoError(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated failure, ${syscall} '${lockPath}'`), {
    code,
    syscall,
  });
}

function lockUnlinkFails(code: string, { times }: { times: number }): void {
  let failures = 0;
  vi.mocked(unlinkSync).mockImplementation((path) => {
    if (path === lockPath && failures < times) {
      failures += 1;
      throw errnoError(code, 'unlink');
    }
    actualFs.unlinkSync(path);
  });
}

function writeExitedHolderLock(): string {
  const text = JSON.stringify({
    pid: 99_990_201,
    hostname: hostname(),
    machineId: getMachineId(),
    port: 1234,
    startedAt: new Date().toISOString(),
    worktreeRoot: '/exited',
  });
  writeFileSync(lockPath, text);
  return text;
}

async function liveHolderLockText(): Promise<string> {
  const holder = await startOwnedProcess();
  owned.push(holder);
  return JSON.stringify(
    legacyServerLock({
      pid: holder.pid,
      startedAt: lockWrittenByRunningProcess(holder),
      machineId: getMachineId(),
      worktreeRoot: '/live',
    }),
  );
}

function acquire() {
  return acquireProcessLock({
    lockName: LOCK_NAME,
    lockDir,
    metadata: { port: 0, worktreeRoot: '/new/boot' },
  });
}

function lockOnDisk(): ProcessLockMetadata {
  return JSON.parse(actualFs.readFileSync(lockPath, 'utf-8'));
}

describe('a stale lock whose removal fails', () => {
  test.each([
    ['EROFS', 'Restore file and parent-directory access, then retry.'],
    ['EBUSY', 'Another program has the lock file open; close it or wait, then retry.'],
    ['EPERM', 'Restore file and parent-directory access, then retry.'],
    ['EISDIR', 'Resolve that error, then retry.'],
  ] as const)('a %s failure aborts without a retry', (code, remedy) => {
    const text = writeExitedHolderLock();
    lockUnlinkFails(code, { times: 1 });

    expect(acquire).toThrow(
      `[server-lock] Could not remove the stale lock at ${lockPath}: ${code}: simulated failure, unlink '${lockPath}'. ${remedy}`,
    );
    expect(actualFs.readFileSync(lockPath, 'utf-8')).toBe(text);
  });
});

describe('a lock path that holds no readable file', () => {
  test('a dangling symbolic link is removed and replaced without creating its target', () => {
    const target = resolve(lockDir, 'moved-away.lock');
    symlinkSync(target, lockPath);

    acquire();

    expect(actualFs.lstatSync(lockPath).isSymbolicLink()).toBe(false);
    expect(lockOnDisk().pid).toBe(process.pid);
    expect(actualFs.existsSync(target)).toBe(false);
  });

  test('a dangling symbolic link that cannot be removed fails naming the link and is kept', () => {
    const target = resolve(lockDir, 'moved-away.lock');
    symlinkSync(target, lockPath);
    lockUnlinkFails('EACCES', { times: Number.POSITIVE_INFINITY });

    expect(acquire).toThrow(
      `[server-lock] Could not remove the broken symbolic link at ${lockPath}: EACCES: simulated failure, unlink '${lockPath}'. Restore file and parent-directory access, then retry.`,
    );
    expect(actualFs.lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(actualFs.existsSync(target)).toBe(false);
  });

  test('a lock that disappears before it is read is retried as a race', () => {
    writeExitedHolderLock();
    let vanished = false;
    vi.mocked(readFileSync).mockImplementation(((
      path: Parameters<typeof readFileSync>[0],
      options,
    ) => {
      if (path === lockPath && !vanished) {
        vanished = true;
        actualFs.unlinkSync(lockPath);
      }
      return actualFs.readFileSync(path, options);
    }) as typeof readFileSync);

    acquire();

    expect(lockOnDisk().pid).toBe(process.pid);
  });

  test('a lock a successor writes after a read found nothing is kept and collides', async () => {
    const successorText = await liveHolderLockText();
    writeExitedHolderLock();
    let vanished = false;
    vi.mocked(readFileSync).mockImplementation(((
      path: Parameters<typeof readFileSync>[0],
      options,
    ) => {
      if (path === lockPath && !vanished) {
        vanished = true;
        actualFs.unlinkSync(lockPath);
        writeFileSync(lockPath, successorText);
        throw errnoError('ENOENT', 'open');
      }
      return actualFs.readFileSync(path, options);
    }) as typeof readFileSync);

    expect(acquire).toThrow(ProcessLockCollisionError);
    expect(actualFs.readFileSync(lockPath, 'utf-8')).toBe(successorText);
  });
});

test('a corrupt lock replaced by a live server before its removal is kept and collides', async () => {
  const successorText = await liveHolderLockText();
  writeFileSync(lockPath, '{ not json');
  let replaced = false;
  vi.mocked(readFileSync).mockImplementation(((
    path: Parameters<typeof readFileSync>[0],
    options,
  ) => {
    const text = actualFs.readFileSync(path, options);
    if (path === lockPath && !replaced) {
      replaced = true;
      writeFileSync(lockPath, successorText);
    }
    return text;
  }) as typeof readFileSync);

  expect(acquire).toThrow(ProcessLockCollisionError);
  expect(actualFs.readFileSync(lockPath, 'utf-8')).toBe(successorText);
});
