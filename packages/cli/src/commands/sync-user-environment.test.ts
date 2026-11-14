import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { withUserGitEnvironment } from './sync.ts';

describe('withUserGitEnvironment', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-sync-user-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs git with the user's editor, SSH and env-count config", async () => {
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      EDITOR: 'vim',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'gitquire.probe',
      GIT_CONFIG_VALUE_0: 'from-env',
    };
    await simpleGit(dir).raw(['init', '-q']);
    const out = await simpleGit(withUserGitEnvironment({ baseDir: dir }, env))
      .env(env)
      .raw(['config', '--get', 'gitquire.probe']);
    expect(out.trim()).toBe('from-env');
  });

  test('keeps abbreviated options working for hooks and helpers', async () => {
    await simpleGit(dir).raw(['init', '-q']);
    const env = { PATH: process.env.PATH ?? '', HOME: dir };
    const out = await simpleGit(withUserGitEnvironment({ baseDir: dir }, env))
      .env(env)
      .raw(['status', '--porc']);
    expect(out).toBe('');
  });
});
