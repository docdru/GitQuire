import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type DiskEvent,
  lastKnownHash,
  type StartWatcherOptions,
  startWatcher,
  type WatcherHandle,
} from './file-watcher.ts';
import { getMetrics } from './metrics.ts';
import { createManualClock } from './watcher-clock.test-helper.ts';

function readCanBeRevoked(): boolean {
  if (process.platform === 'win32') return false;
  const dir = mkdtempSync(join(tmpdir(), 'gq-revoke-probe-'));
  const probe = join(dir, 'probe');
  try {
    writeFileSync(probe, 'probe');
    chmodSync(probe, 0o000);
    try {
      readFileSync(probe);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') return true;
      throw err;
    }
  } finally {
    chmodSync(probe, 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
}

const CAN_REVOKE_READ = readCanBeRevoked();

function eventsFor(events: readonly DiskEvent[], kind: DiskEvent['kind'], docName: string) {
  return events.filter(
    (event) => event.kind === kind && 'docName' in event && event.docName === docName,
  );
}

describe('re-checking the content folder', () => {
  let tmpDir: string;
  let contentDir: string;
  let handle: WatcherHandle | undefined;
  let events: DiskEvent[];
  const revoked: string[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gq-watcher-recheck-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    contentDir = realpathSync(contentDir);
    lastKnownHash.clear();
    events = [];
  });

  afterEach(async () => {
    await handle?.unsubscribe();
    handle = undefined;
    vi.useRealTimers();
    for (const locked of revoked.splice(0)) chmodSync(locked, 0o755);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function revokeRead(path: string): void {
    chmodSync(path, 0o000);
    revoked.push(path);
  }

  function moveModificationTimeLater(path: string): void {
    const { atime, mtime } = statSync(path);
    utimesSync(path, atime, new Date(mtime.getTime() + 2_000));
  }

  async function watch(
    extra: Pick<StartWatcherOptions, 'onRecoveryComplete' | 'onRecoveryPassCompleted'> = {},
  ): Promise<WatcherHandle> {
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { clock: createManualClock(Date.now()), ...extra },
    );
    return handle;
  }

  test('a re-check finds and applies a write made outside the page store, and reports what it found', async () => {
    await watch();
    writeFileSync(join(contentDir, 'silent.md'), '# Silent\n');

    const before = events.length;
    const result = await (handle as WatcherHandle).recheck();
    const pass = events.slice(before);
    expect(result.status).toBe('completed');
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    expect(eventsFor(pass, 'create', 'silent')).toHaveLength(1);
    expect(handle?.getFileIndex().has('silent')).toBe(true);

    const again = await (handle as WatcherHandle).recheck();
    expect(again).toEqual({ status: 'completed', candidates: 0, dispatched: 0 });
  });

  test('concurrent re-check requests coalesce into one pass', async () => {
    await watch();
    writeFileSync(join(contentDir, 'once.md'), '# Once\n');
    const first = (handle as WatcherHandle).recheck();
    const second = (handle as WatcherHandle).recheck();
    expect(second).toBe(first);
    const result = await first;
    expect(result.status).toBe('completed');
    expect(result.candidates).toBeGreaterThanOrEqual(1);
  });

  test('a full re-check lists an empty folder created outside the page store', async () => {
    await watch();
    mkdirSync(join(contentDir, 'empty-folder'));

    await (handle as WatcherHandle).recheck('full');
    expect(handle?.getFolderIndex().has('empty-folder')).toBe(true);
    expect(
      events.some(
        (event) => event.kind === 'folder-create' && event.relativePath === 'empty-folder',
      ),
    ).toBe(true);
  });

  test('a re-read while the content folder is missing reports no document deleted', async () => {
    const kept = join(contentDir, 'kept.md');
    writeFileSync(kept, '# Kept\n');
    await watch();

    rmSync(contentDir, { recursive: true, force: true });
    const result = await (handle as WatcherHandle).recheckPaths([kept]);
    expect(result).toEqual({ checked: 0, found: 0 });
    expect(events.filter((event) => event.kind === 'delete')).toHaveLength(0);
    expect(handle?.getFileIndex().has('kept')).toBe(true);
  });

  test('a re-read under an intact content folder reports a file deleted outside the app', async () => {
    const gone = join(contentDir, 'gone.md');
    writeFileSync(gone, '# Gone\n');
    await watch();

    rmSync(gone);
    const result = await (handle as WatcherHandle).recheckPaths([gone]);
    expect(result).toEqual({ checked: 1, found: 1 });
    expect(eventsFor(events, 'delete', 'gone')).toHaveLength(1);
  });

  test.runIf(process.platform !== 'win32')(
    'a re-read of a FIFO or a link to a device returns without reading it',
    async () => {
      await watch();
      const fifo = join(contentDir, 'pipe.md');
      execFileSync('mkfifo', [fifo]);
      const device = join(contentDir, 'zero.md');
      symlinkSync('/dev/zero', device);

      const result = await (handle as WatcherHandle).recheckPaths([fifo, device]);
      expect(result).toEqual({ checked: 2, found: 0 });
      expect(events).toHaveLength(0);
    },
  );

  test.runIf(process.platform !== 'win32')(
    'a re-read of a non-Markdown FIFO or a link to a device lists neither',
    async () => {
      await watch();
      const fifo = join(contentDir, 'pipe.bin');
      execFileSync('mkfifo', [fifo]);
      const device = join(contentDir, 'zero.png');
      symlinkSync('/dev/zero', device);

      const result = await (handle as WatcherHandle).recheckPaths([fifo, device]);
      expect(result.found).toBe(0);
      expect(events).toHaveLength(0);
    },
  );

  test.runIf(CAN_REVOKE_READ)(
    'a file that cannot be read does not stop a re-check from applying a change beside it',
    async () => {
      const locked = join(contentDir, 'locked.md');
      writeFileSync(locked, '# Locked\n');
      writeFileSync(join(contentDir, 'open.md'), '# Open\n');
      await watch();
      const unreadableBefore = getMetrics().watcherUnreadableEntries;

      revokeRead(locked);
      moveModificationTimeLater(locked);
      writeFileSync(join(contentDir, 'open.md'), '# Open, edited outside\n');
      await (handle as WatcherHandle).recheck();
      expect(eventsFor(events, 'update', 'open')).toHaveLength(1);
      expect(eventsFor(events, 'delete', 'locked')).toHaveLength(0);
      expect(handle?.getFileIndex().has('locked')).toBe(true);
      expect(getMetrics().watcherUnreadableEntries - unreadableBefore).toBeGreaterThanOrEqual(1);
    },
  );

  test.runIf(CAN_REVOKE_READ)(
    'a folder that cannot be listed keeps its documents while the rest of the tree is checked',
    async () => {
      mkdirSync(join(contentDir, 'private'));
      writeFileSync(join(contentDir, 'private', 'inside.md'), '# Inside\n');
      writeFileSync(join(contentDir, 'open.md'), '# Open\n');
      await watch();

      revokeRead(join(contentDir, 'private'));
      writeFileSync(join(contentDir, 'open.md'), '# Open, edited outside\n');
      await (handle as WatcherHandle).recheck();
      expect(eventsFor(events, 'update', 'open')).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'delete')).toHaveLength(0);
      expect(events.filter((event) => event.kind === 'folder-delete')).toHaveLength(0);
      expect(handle?.getFileIndex().has('private/inside')).toBe(true);
    },
  );

  test.runIf(CAN_REVOKE_READ)(
    'the per-pass hook says whether a completed pass observed the whole tree',
    async () => {
      writeFileSync(join(contentDir, 'open.md'), '# Open\n');
      const passes: Array<{ pass: number; whole: boolean }> = [];
      await watch({
        onRecoveryPassCompleted: async (pass, whole) => {
          passes.push({ pass, whole });
        },
      });

      await (handle as WatcherHandle).recheck();
      expect(passes.at(-1)?.whole).toBe(true);

      mkdirSync(join(contentDir, 'locked'));
      revokeRead(join(contentDir, 'locked'));
      await (handle as WatcherHandle).recheck();
      expect(passes.at(-1)?.whole).toBe(false);
    },
  );

  test('a pass that cannot read the content root reports no completed pass', async () => {
    writeFileSync(join(contentDir, 'kept.md'), '# Kept\n');
    const passes: number[] = [];
    await watch({
      onRecoveryPassCompleted: async (pass) => {
        passes.push(pass);
      },
    });
    const before = passes.length;

    rmSync(contentDir, { recursive: true, force: true });
    const result = await (handle as WatcherHandle).recheck();
    expect(result.status).toBe('incomplete');
    expect(passes).toHaveLength(before);
  });

  test('a content root that is gone leaves the known documents in place instead of deleting them', async () => {
    writeFileSync(join(contentDir, 'kept.md'), '# Kept\n');
    await watch();
    expect(handle?.getFileIndex().has('kept')).toBe(true);

    rmSync(contentDir, { recursive: true, force: true });
    const result = await (handle as WatcherHandle).recheck();
    expect(result.status).toBe('incomplete');
    expect(events.filter((event) => event.kind === 'delete')).toHaveLength(0);
    expect(handle?.getFileIndex().has('kept')).toBe(true);
  });
});
