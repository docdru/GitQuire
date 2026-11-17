import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { GqCliCommand } from '@gitquire/core';
import { describe, expect, test } from 'vitest';
import {
  __resetResolveOnPathCacheForTests,
  __seedResolveOnPathCacheForTests,
} from '../git-preflight.ts';
import { withBrokenBareGitOnly } from '../git-unusable-setup.test-helper.ts';
import { runCloneSubprocess } from './clone-flow.ts';

const okCli = (
  cliArgs: readonly string[],
  cliEnv?: Readonly<Record<string, string | undefined>>,
): GqCliCommand => GqCliCommand.resolve({ host: { cliArgs, cliEnv }, env: {} });

function pathCapturingCli(pathFile: string, dir: string): readonly string[] {
  return [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(pathFile)}, process.env.PATH ?? ''); console.log(JSON.stringify({ type: 'complete', dir: ${JSON.stringify(dir)} }));`,
  ];
}

describe('runCloneSubprocess — clone-child PATH binding (#356)', () => {
  test('enriches the clone child PATH with the absolute dir of the validated fallback git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok356-clonebind-'));
    const pathFile = join(dir, 'observed-path.txt');
    try {
      await withBrokenBareGitOnly(async () => {
        const controller = runCloneSubprocess({
          cli: okCli(pathCapturingCli(pathFile, dir)),
          url: 'https://github.com/octocat/hello.git',
          dir,
          timeoutMs: 30_000,
          onEvent: () => {},
        });
        await controller.done;
      });

      const observed = readFileSync(pathFile, 'utf-8');
      const firstSegment = observed.split(delimiter)[0];
      expect(isAbsolute(firstSegment)).toBe(true);
      expect(existsSync(join(firstSegment, 'git'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not prepend a relative "." to the clone child PATH when the resolved git path is the bare name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok356-clonepath-'));
    const pathFile = join(dir, 'observed-path.txt');
    __resetResolveOnPathCacheForTests();
    __seedResolveOnPathCacheForTests('git', 'git');
    try {
      const controller = runCloneSubprocess({
        cli: okCli(pathCapturingCli(pathFile, dir)),
        url: 'https://github.com/octocat/hello.git',
        dir,
        timeoutMs: 30_000,
        onEvent: () => {},
      });
      await controller.done;

      const observed = readFileSync(pathFile, 'utf-8');
      const firstSegment = observed.split(delimiter)[0];
      expect(firstSegment).not.toBe('.');
    } finally {
      __resetResolveOnPathCacheForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
