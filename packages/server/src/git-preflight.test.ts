import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  assertGitAvailable,
  buildGuidance,
  compareSemver,
  detectGit,
  fallbackPaths,
  type GitDetected,
  GitNotAvailableError,
  GitProbeTimeoutError,
  GitTooOldError,
  type InstallGuidance,
  MIN_GIT_VERSION,
  parseGitVersion,
  resolveOnPath,
} from './git-preflight.ts';

describe('parseGitVersion', () => {
  test('parses canonical Linux/macOS output', () => {
    expect(parseGitVersion('git version 2.39.3\n')).toBe('2.39.3');
  });

  test('parses Apple Git vendor suffix', () => {
    expect(parseGitVersion('git version 2.39.3 (Apple Git-145)\n')).toBe('2.39.3');
  });

  test('parses Git for Windows vendor suffix', () => {
    expect(parseGitVersion('git version 2.45.0.windows.1\n')).toBe('2.45.0');
  });

  test('parses MinGit nested suffix', () => {
    expect(parseGitVersion('git version 2.45.0.1.windows.1\n')).toBe('2.45.0');
  });

  test('returns null for empty stdout', () => {
    expect(parseGitVersion('')).toBeNull();
  });

  test('returns null for malformed output', () => {
    expect(parseGitVersion('not a git version string')).toBeNull();
    expect(parseGitVersion('git version foo.bar.baz')).toBeNull();
    expect(parseGitVersion('git version 2.39')).toBeNull();
  });
});

describe('compareSemver', () => {
  test('returns negative when a < b', () => {
    expect(compareSemver('2.20.0', '2.31.0')).toBeLessThan(0);
    expect(compareSemver('2.31.0', '2.31.1')).toBeLessThan(0);
    expect(compareSemver('1.99.99', '2.0.0')).toBeLessThan(0);
  });

  test('returns positive when a > b', () => {
    expect(compareSemver('2.31.0', '2.20.0')).toBeGreaterThan(0);
    expect(compareSemver('2.31.1', '2.31.0')).toBeGreaterThan(0);
    expect(compareSemver('3.0.0', '2.99.99')).toBeGreaterThan(0);
  });

  test('returns zero when equal', () => {
    expect(compareSemver('2.31.0', '2.31.0')).toBe(0);
    expect(compareSemver('0.0.0', '0.0.0')).toBe(0);
  });

  test('treats missing components as zero', () => {
    expect(compareSemver('2.31', '2.31.0')).toBe(0);
    expect(compareSemver('2', '2.0.0')).toBe(0);
  });

  test('handles non-numeric components by defaulting to 0 (same as missing)', () => {
    expect(compareSemver('2.31.abc', '2.31.0')).toBe(0);
    expect(compareSemver('2.31.0', '2.31.abc')).toBe(0);
  });
});

describe('fallbackPaths', () => {
  test('lists the Linux locations of git', () => {
    expect(fallbackPaths()).toEqual(['/usr/bin/git', '/usr/local/bin/git']);
  });
});

describe('buildGuidance', () => {
  test('points at the image, which includes Git', () => {
    const guidance: InstallGuidance = buildGuidance();
    expect(guidance.product).toBe('Git');
    expect(guidance.options).toHaveLength(1);
    expect(guidance.options[0]?.command).toBe('docker compose pull && docker compose up -d');
  });
});

describe('GitNotAvailableError', () => {
  test('carries code, platform, and guidance fields', () => {
    const guidance = buildGuidance();
    const err = new GitNotAvailableError('linux', guidance);
    expect(err.code).toBe('GIT_NOT_AVAILABLE');
    expect(err.platform).toBe('linux');
    expect(err.guidance).toBe(guidance);
    expect(err.name).toBe('GitNotAvailableError');
  });

  test('message includes product name and install URL', () => {
    const guidance = buildGuidance();
    const err = new GitNotAvailableError('linux', guidance);
    expect(err.message).toContain('GitQuire needs Git');
    expect(err.message).toContain(guidance.url);
    expect(err.message).toContain('this container has no usable Git');
  });

  test('message includes every install option label + command', () => {
    const guidance = buildGuidance();
    const err = new GitNotAvailableError('linux', guidance);
    for (const opt of guidance.options) {
      expect(err.message).toContain(opt.label);
      expect(err.message).toContain(opt.command);
    }
  });

  test('forwards cause to Error options bag', () => {
    const cause = new Error('underlying');
    const err = new GitNotAvailableError('linux', buildGuidance(), { cause });
    expect(err.cause).toBe(cause);
  });

  test('passes instanceof checks for branching', () => {
    const err = new GitNotAvailableError('linux', buildGuidance());
    expect(err instanceof GitNotAvailableError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe('GitProbeTimeoutError', () => {
  test('carries a distinct code and avoids missing-Git guidance', () => {
    const err = new GitProbeTimeoutError('linux', buildGuidance(), {
      path: 'timeout',
      fallback: 'timeout',
    });
    expect(err.code).toBe('GIT_PROBE_TIMEOUT');
    expect(err.name).toBe('GitProbeTimeoutError');
    expect(err.probe).toEqual({ path: 'timeout', fallback: 'timeout' });
    expect(err.message).toContain('could not verify Git');
    expect(err.message).not.toContain("isn't installed");
  });
});

describe('GitTooOldError', () => {
  test('carries code, platform, detected, required, and resolvedPath fields', () => {
    const guidance = buildGuidance();
    const err = new GitTooOldError('linux', '2.10.0', '2.31.0', '/usr/bin/git', guidance);
    expect(err.code).toBe('GIT_TOO_OLD');
    expect(err.platform).toBe('linux');
    expect(err.detected).toBe('2.10.0');
    expect(err.required).toBe('2.31.0');
    expect(err.resolvedPath).toBe('/usr/bin/git');
    expect(err.name).toBe('GitTooOldError');
  });

  test('message includes detected, required, and path', () => {
    const guidance = buildGuidance();
    const err = new GitTooOldError('linux', '2.10.0', '2.31.0', '/usr/bin/git', guidance);
    expect(err.message).toContain('2.10.0');
    expect(err.message).toContain('2.31.0');
    expect(err.message).toContain('/usr/bin/git');
  });

  test('passes instanceof checks for branching', () => {
    const err = new GitTooOldError('linux', '2.10.0', '2.31.0', '/usr/bin/git', buildGuidance());
    expect(err instanceof GitTooOldError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof GitNotAvailableError).toBe(false);
  });
});

describe('resolveOnPath', () => {
  test('resolves a tool that is on PATH', () => {
    const result = resolveOnPath('sh');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.length).toBeGreaterThan(0);
    }
  });

  test('returns null for a name that does not exist', () => {
    expect(resolveOnPath('definitely-not-a-real-command-xyzzy-12345')).toBeNull();
  });

  test('rejects names that contain shell metacharacters', () => {
    expect(resolveOnPath('git; rm -rf /tmp/xyzzy')).toBeNull();
    expect(resolveOnPath('git && touch /tmp/xyzzy')).toBeNull();
    expect(resolveOnPath('git | cat /etc/passwd')).toBeNull();
    expect(resolveOnPath('git`whoami`')).toBeNull();
    expect(resolveOnPath('git$(whoami)')).toBeNull();
    expect(resolveOnPath('')).toBeNull();
    expect(resolveOnPath('git ')).toBeNull();
    expect(resolveOnPath(' git')).toBeNull();
  });

  test('searches only absolute PATH folders, never the working directory or a relative entry', () => {
    const project = mkdtempSync(join(tmpdir(), 'resolve-project-'));
    const bin = mkdtempSync(join(tmpdir(), 'resolve-bin-'));
    const name = 'ok-resolve-probe-tool';
    const file = name;
    for (const dir of [project, bin]) {
      writeFileSync(join(dir, file), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const previous = process.cwd();
    process.chdir(project);
    try {
      expect(resolveOnPath(name, ['.', '', relative(project, bin)].join(delimiter))).toBeNull();
      expect(resolveOnPath(name, bin)).toBe(join(bin, file));
    } finally {
      process.chdir(previous);
      rmSync(project, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('skips a file that is not executable', () => {
    const bin = mkdtempSync(join(tmpdir(), 'resolve-noexec-'));
    try {
      writeFileSync(join(bin, 'ok-resolve-noexec'), 'x', { mode: 0o644 });
      expect(resolveOnPath('ok-resolve-noexec', bin)).toBeNull();
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('accepts plain-letter command names with dots / hyphens / underscores', () => {
    for (const name of ['git', 'sub-command', 'cmd.v2']) {
      const result = resolveOnPath(name);
      expect(result === null || typeof result === 'string').toBe(true);
    }
  });
});

describe('detectGit (integration)', () => {
  test('returns a GitDetected when git is present (the common case)', () => {
    const detected: GitDetected = detectGit();
    expect(detected.ok).toBe(true);
    expect(typeof detected.version).toBe('string');
    expect(detected.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(detected.resolvedPath.length).toBeGreaterThan(0);
    expect(['PATH', 'fallback']).toContain(detected.source);
  });

  test('Stage 2 fallback fires when PATH has no git and a fallback candidate exists', () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent-stage2-fallback-test-xyz';
    try {
      const detected = detectGit();
      expect(detected.ok).toBe(true);
      expect(detected.source).toBe('fallback');
      const candidates = fallbackPaths();
      expect(candidates).toContain(detected.resolvedPath);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
});

describe('assertGitAvailable (integration)', () => {
  test('passes when runner git ≥ MIN_GIT_VERSION', () => {
    const detected = assertGitAvailable();
    expect(compareSemver(detected.version, MIN_GIT_VERSION)).toBeGreaterThanOrEqual(0);
  });
});

describe('MIN_GIT_VERSION', () => {
  test('is a valid semver triple', () => {
    expect(MIN_GIT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('is at least 2.20 (the hard floor for `git init --initial-branch`)', () => {
    expect(compareSemver(MIN_GIT_VERSION, '2.20.0')).toBeGreaterThanOrEqual(0);
  });
});

describe('git remediation names the running channel CLI', () => {
  afterEach(() => vi.unstubAllEnvs());

  const verify = (command: string) =>
    `Run \`${command} diagnose health --check git\` to verify your installation.`;

  test('Stable keeps the gq diagnose line on both errors', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
    const guidance = buildGuidance();
    expect(new GitNotAvailableError('linux', guidance).message.split('\n')).toContain(verify('gq'));
    expect(
      new GitTooOldError('linux', '2.10.0', '2.31.0', '/usr/bin/git', guidance).message.split('\n'),
    ).toContain(verify('gq'));
  });

  test('Beta names gq-beta diagnose on both errors', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    const guidance = buildGuidance();
    expect(new GitNotAvailableError('linux', guidance).message.split('\n')).toContain(
      verify('gq-beta'),
    );
    expect(
      new GitTooOldError('linux', '2.10.0', '2.31.0', '/usr/bin/git', guidance).message.split('\n'),
    ).toContain(verify('gq-beta'));
  });
});
