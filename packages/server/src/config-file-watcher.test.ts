import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type ConfigFileWatcher,
  startConfigFileWatcher,
  startMultiPathConfigFileWatcher,
} from './config-file-watcher.ts';

let root: string;
const watchers: ConfigFileWatcher[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gq-config-watcher-'));
});

afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher();
  rmSync(root, { recursive: true, force: true });
});

describe('startConfigFileWatcher', () => {
  test('does not report the content present at start', async () => {
    const path = join(root, 'config.yml');
    writeFileSync(path, 'a: 1\n');
    const onChange = vi.fn();
    const watcher = await startConfigFileWatcher(path, onChange);
    watchers.push(watcher);
    expect(await watcher.recheck()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('reports a changed file on the next re-check and waits for the handler', async () => {
    const path = join(root, 'config.yml');
    let applied = '';
    const watcher = await startConfigFileWatcher(path, async (content) => {
      await Promise.resolve();
      applied = content;
    });
    watchers.push(watcher);
    writeFileSync(path, 'b: 2\n');
    expect(await watcher.recheck()).toBe(true);
    expect(applied).toBe('b: 2\n');
    expect(await watcher.recheck()).toBe(false);
  });

  test('ignores a removed file and keeps the last content', async () => {
    const path = join(root, 'config.yml');
    writeFileSync(path, 'a: 1\n');
    const onChange = vi.fn();
    const watcher = await startConfigFileWatcher(path, onChange);
    watchers.push(watcher);
    unlinkSync(path);
    expect(await watcher.recheck()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a handler that throws does not break later re-checks', async () => {
    const path = join(root, 'config.yml');
    const onChange = vi.fn(() => {
      throw new Error('boom');
    });
    const watcher = await startConfigFileWatcher(path, onChange);
    watchers.push(watcher);
    writeFileSync(path, 'c: 3\n');
    expect(await watcher.recheck()).toBe(true);
    writeFileSync(path, 'c: 4\n');
    expect(await watcher.recheck()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test('resync takes the file as it is now without reporting it', async () => {
    const path = join(root, 'config.yml');
    const onChange = vi.fn();
    const watcher = await startConfigFileWatcher(path, onChange);
    watchers.push(watcher);
    writeFileSync(path, 'own: write\n');
    watcher.resync();
    expect(await watcher.recheck()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('startMultiPathConfigFileWatcher', () => {
  test('rejects an empty list of paths', async () => {
    await expect(startMultiPathConfigFileWatcher([], vi.fn())).rejects.toThrow();
  });

  test('reports each changed path once', async () => {
    const first = join(root, '.okignore');
    const second = join(root, '.gitignore');
    const onChange = vi.fn();
    const watcher = await startMultiPathConfigFileWatcher([first, second], onChange);
    watchers.push(watcher);
    writeFileSync(second, 'dist/\n');
    expect(await watcher.recheck()).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(second, 'dist/\n');
    expect(await watcher.recheck()).toBe(false);
  });

  test('reports a removed file once, as empty', async () => {
    const first = join(root, '.okignore');
    writeFileSync(first, 'tmp/\n');
    const onChange = vi.fn();
    const watcher = await startMultiPathConfigFileWatcher([first], onChange);
    watchers.push(watcher);
    unlinkSync(first);
    expect(await watcher.recheck()).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(first, '');
    expect(await watcher.recheck()).toBe(false);
  });
});
