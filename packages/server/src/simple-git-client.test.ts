import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GIT_ALLOWED_ENVIRONMENT, simpleGit } from './simple-git-client.ts';

describe('simpleGit client defaults', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-simple-git-client-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('passes the git variables GitQuire sets through .env()', async () => {
    const gitDir = join(dir, 'shadow.git');
    await simpleGit(dir).raw(['init', '--bare', gitDir]);
    const env = {
      PATH: process.env.PATH ?? '',
      GIT_DIR: gitDir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const out = await simpleGit({ baseDir: dir, unsafe: { allowUnsafeConfigPaths: true } })
      .env(env)
      .raw(['rev-parse', '--git-dir']);
    expect(out.trim()).toBe(gitDir);
  });

  test('still refuses a guarded variable GitQuire does not set', async () => {
    const git = simpleGit(dir).env({
      PATH: process.env.PATH ?? '',
      GIT_TRACE2_EVENT: '/tmp/trace',
    });
    await expect(git.raw(['--version'])).rejects.toThrow('allowEnvironment');
  });

  test('merges a caller allowEnvironment with the defaults', async () => {
    const git = simpleGit(dir, {
      allowEnvironment: ['GIT_PAGER'],
      unsafe: { allowUnsafePager: true },
    }).env({ PATH: process.env.PATH ?? '', GIT_PAGER: 'cat', GIT_DIR: join(dir, 'missing') });
    await expect(git.raw(['--version'])).resolves.toContain('git version');
  });

  test('covers every GIT_CONFIG slot up to 32', () => {
    expect(GIT_ALLOWED_ENVIRONMENT).toContain('GIT_CONFIG_KEY_31');
    expect(GIT_ALLOWED_ENVIRONMENT).toContain('GIT_CONFIG_VALUE_31');
  });
});
