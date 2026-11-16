import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfigPath } from '../config/write-config-patch.ts';
import { posixOkManagedBinDir } from './ok-dir.ts';
import { okUserHomeDir } from './ok-user-home.ts';

const HOME = '/Users/someone';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('per-channel user home', () => {
  it('keeps Stable on ~/.gitquire exactly as before', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
    expect(okUserHomeDir(HOME)).toBe(join(HOME, '.gitquire'));
    expect(posixOkManagedBinDir(HOME)).toBe('/Users/someone/.gitquire/bin');
    expect(resolveConfigPath('user', '/project', HOME)).toBe(
      resolve(HOME, '.gitquire', 'global.yml'),
    );
  });

  it('gives Beta a sibling ~/.gitquire-beta root for its home, PATH shims, and user config', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    expect(okUserHomeDir(HOME)).toBe(join(HOME, '.gitquire-beta'));
    expect(posixOkManagedBinDir(HOME)).toBe('/Users/someone/.gitquire-beta/bin');
    expect(resolveConfigPath('user', '/project', HOME)).toBe(
      resolve(HOME, '.gitquire-beta', 'global.yml'),
    );
  });

  it('never nests one channel root inside the other', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
    const stable = okUserHomeDir(HOME);
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    const beta = okUserHomeDir(HOME);
    expect(relative(stable, beta).startsWith('..')).toBe(true);
    expect(relative(beta, stable).startsWith('..')).toBe(true);
  });

  it('resolves the channel from a Beta executable without an override', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', undefined);
    const execPath = process.execPath;
    Object.defineProperty(process, 'execPath', {
      value: '/Applications/OpenKnowledge Beta.app/Contents/MacOS/OpenKnowledge Beta',
      configurable: true,
    });
    try {
      expect(okUserHomeDir(HOME)).toBe(join(HOME, '.gitquire-beta'));
    } finally {
      Object.defineProperty(process, 'execPath', { value: execPath, configurable: true });
    }
  });
});
