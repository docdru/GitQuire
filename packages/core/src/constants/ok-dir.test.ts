import { posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GQ_BIN_DIRNAME, GQ_DIR, okUserHomeDisplayPath, posixOkManagedBinDir } from './ok-dir.ts';

describe('okUserHomeDisplayPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('names the Stable home folder by default', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', '');
    expect(okUserHomeDisplayPath()).toBe('~/.gitquire');
    expect(okUserHomeDisplayPath('global.yml')).toBe('~/.gitquire/global.yml');
    expect(okUserHomeDisplayPath('logs')).toBe('~/.gitquire/logs');
  });

  test('names the Beta home folder when the running channel is Beta', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    expect(okUserHomeDisplayPath('global.yml')).toBe('~/.gitquire-beta/global.yml');
    expect(okUserHomeDisplayPath('secrets.yml')).toBe('~/.gitquire-beta/secrets.yml');
  });
});

describe('posixOkManagedBinDir', () => {
  beforeEach(() => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('is the OK dir plus the bin dirname, under the given home', () => {
    expect(posixOkManagedBinDir('/Users/alice')).toBe(`/Users/alice/${GQ_DIR}/${GQ_BIN_DIRNAME}`);
    expect(posixOkManagedBinDir('/Users/alice')).toBe('/Users/alice/.gitquire/bin');
  });

  test('normalizes trailing separators on the home it is given', () => {
    expect(posixOkManagedBinDir('/Users/alice/')).toBe('/Users/alice/.gitquire/bin');
    expect(posixOkManagedBinDir('/Users/alice///')).toBe('/Users/alice/.gitquire/bin');
  });

  test('collapses repeated interior separators the way posix.join would', () => {
    expect(posixOkManagedBinDir('/Users//alice')).toBe('/Users/alice/.gitquire/bin');
    expect(posixOkManagedBinDir('//Users/alice')).toBe('/Users/alice/.gitquire/bin');
  });

  test('leaves a backslash alone, since it is a legal character in a POSIX home', () => {
    expect(posixOkManagedBinDir('/home/a\\b')).toBe('/home/a\\b/.gitquire/bin');
  });

  test('leaves a root home resolvable', () => {
    expect(posixOkManagedBinDir('/')).toBe('/.gitquire/bin');
  });

  test('stays byte-identical to the posix join both call sites used before they shared it', () => {
    for (const home of ['/Users/alice', '/Users/alice/', '/home/a\\b', '/']) {
      expect(posixOkManagedBinDir(home)).toBe(posix.join(home, GQ_DIR, GQ_BIN_DIRNAME));
    }
  });
});
