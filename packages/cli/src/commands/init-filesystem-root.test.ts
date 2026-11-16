import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GQ_DIR } from '../constants.ts';

const rootLike = vi.hoisted(() => ({ dir: '' }));

vi.mock('@gitquire/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitquire/server')>();
  return {
    ...actual,
    isFilesystemRoot: (dir: string, platform?: NodeJS.Platform) =>
      dir === rootLike.dir || actual.isFilesystemRoot(dir, platform),
  };
});

const { FilesystemRootProjectError, initCommand, runInit } = await import('./init.ts');

describe('gq init refuses the top of a drive', () => {
  let testDir: string;
  let fakeHome: string;
  let driveRoot: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'init-root-refusal-test-')));
    fakeHome = join(testDir, 'fakehome');
    driveRoot = join(testDir, 'drive');
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    mkdirSync(driveRoot, { recursive: true });
    rootLike.dir = driveRoot;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rootLike.dir = '';
    rmSync(testDir, { recursive: true, force: true });
  });

  it('throws FilesystemRootProjectError and writes nothing', async () => {
    await expect(
      runInit({
        cwd: driveRoot,
        home: fakeHome,
        installUserSkill: async () => 'installed' as const,
        scope: 'project',
        skills: true,
      }),
    ).rejects.toBeInstanceOf(FilesystemRootProjectError);

    expect(existsSync(join(driveRoot, '.git'))).toBe(false);
    expect(existsSync(join(driveRoot, GQ_DIR))).toBe(false);
    expect(existsSync(join(driveRoot, '.okignore'))).toBe(false);
  });

  it('the command action prints the refusal and exits 64', async () => {
    const savedCwd = process.cwd();
    const savedExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.chdir(driveRoot);

      await initCommand().parseAsync([], { from: 'user' });

      expect(process.exitCode).toBe(64);
      const printed = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(printed).toContain('Refusing to set up a GitQuire project at the top of a drive');
      expect(existsSync(join(driveRoot, GQ_DIR))).toBe(false);
    } finally {
      process.chdir(savedCwd);
      process.exitCode = savedExitCode;
      stderrSpy.mockRestore();
    }
  });
});
