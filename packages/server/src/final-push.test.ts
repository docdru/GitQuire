import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import * as Y from 'yjs';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { loggerFactory } from './logger.ts';
import { createServer, pushBeforeStop } from './server-factory.ts';

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

function git(args: string[], cwd: string): string {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    ),
  });
}

const roots: string[] = [];
afterEach(() => {
  loggerFactory.reset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithRemote(): { project: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), 'gq-final-push-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const project = join(root, 'wiki');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin], root);
  git(['init', '--quiet', '--initial-branch=main', project], root);
  configureTestGitRepository(project);
  writeFileSync(join(project, 'start.md'), '# Start\n');
  git(['add', '-A'], project);
  git(['commit', '--quiet', '-m', 'start'], project);
  git(['remote', 'add', 'origin', origin], project);
  git(['push', '--quiet', '-u', 'origin', 'main'], project);
  const local = join(project, '.gitquire', 'local');
  mkdirSync(local, { recursive: true });
  writeFileSync(
    join(local, 'config.yml'),
    stringifyYaml({
      autoSync: { mode: 'full', pullIntervalSeconds: 3600, pushIntervalSeconds: 3600 },
    }),
  );
  return { project, origin };
}

async function editAndStop(project: string, finalPushTimeoutMs: number): Promise<void> {
  const server = createServer({
    contentDir: project,
    projectDir: project,
    quiet: true,
    debounce: 60_000,
    finalPushTimeoutMs,
  });
  await server.ready;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const conn = await server.hocuspocus.openDirectConnection('last-words');
  await conn.transact((doc) => {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('typed just before the stop')]);
    doc.getXmlFragment('default').insert(0, [paragraph]);
  });
  server.hocuspocus.documents.get('last-words')?.removeDirectConnection();
  await server.destroy();
}

function originFiles(origin: string): string {
  return git(['ls-tree', '-r', '--name-only', 'main'], origin);
}

describe('commit and push, then stop', () => {
  test('pushes the last edits on stop when a final push is asked for', async () => {
    const { project, origin } = projectWithRemote();
    await editAndStop(project, 20_000);
    expect(originFiles(origin)).toContain('last-words.md');
  }, 60_000);

  test('stops without pushing when no final push is asked for, as before', async () => {
    const { project, origin } = projectWithRemote();
    await editAndStop(project, 0);
    expect(originFiles(origin)).not.toContain('last-words.md');
  }, 60_000);
});

describe('pushBeforeStop', () => {
  const status = (syncMode: string, hasRemote: boolean, pushError?: string) => ({
    syncMode,
    hasRemote,
    ...(pushError === undefined ? {} : { pushError }),
  });

  test('pushes only in full sync with a remote', async () => {
    let pushes = 0;
    const engine = (s: ReturnType<typeof status>) =>
      ({
        getStatus: () => s,
        pushOnce: async () => {
          pushes++;
        },
      }) as unknown as Parameters<typeof pushBeforeStop>[0];
    expect(await pushBeforeStop(engine(status('follow', true)), 1000)).toBe('skipped');
    expect(await pushBeforeStop(engine(status('full', false)), 1000)).toBe('skipped');
    expect(pushes).toBe(0);
    expect(await pushBeforeStop(engine(status('full', true)), 1000)).toBe('pushed');
    expect(await pushBeforeStop(engine(status('full', true, 'rejected')), 1000)).toBe('failed');
    expect(pushes).toBe(2);
  });

  test('gives up after its time', async () => {
    const engine = {
      getStatus: () => status('full', true),
      pushOnce: () => new Promise<void>(() => {}),
    } as unknown as Parameters<typeof pushBeforeStop>[0];
    expect(await pushBeforeStop(engine, 20)).toBe('timeout');
  });
});
