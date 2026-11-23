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

async function editAndStop(
  project: string,
  finalPushTimeoutMs: number,
  options: { cycleInFlight?: boolean } = {},
): Promise<void> {
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
  const running = options.cycleInFlight === true ? server.syncEngine?.pushOnce() : undefined;
  await server.destroy();
  await running;
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

  test('waits for a push cycle in flight, then pushes the last edits', async () => {
    const { project, origin } = projectWithRemote();
    await editAndStop(project, 20_000, { cycleInFlight: true });
    expect(originFiles(origin)).toContain('last-words.md');
  }, 60_000);

  test('stops without pushing when no final push is asked for, as before', async () => {
    const { project, origin } = projectWithRemote();
    await editAndStop(project, 0);
    expect(originFiles(origin)).not.toContain('last-words.md');
  }, 60_000);
});

describe('pushBeforeStop', () => {
  const status = (syncMode: string, hasRemote: boolean) => ({ syncMode, hasRemote });
  type Engine = Parameters<typeof pushBeforeStop>[0];
  const engine = (s: ReturnType<typeof status>, push: () => Promise<void>): Engine =>
    ({ getStatus: () => s, pushForStop: push }) as unknown as Engine;

  test('pushes only in full sync with a remote', async () => {
    let pushes = 0;
    const push = async () => {
      pushes++;
    };
    const done = async () => true;
    expect(await pushBeforeStop(engine(status('follow', true), push), 1000, done)).toBe('skipped');
    expect(await pushBeforeStop(engine(status('full', false), push), 1000, done)).toBe('skipped');
    expect(pushes).toBe(0);
    expect(await pushBeforeStop(engine(status('full', true), push), 1000, done)).toBe('pushed');
    expect(pushes).toBe(1);
  });

  test('reports a push that left work behind as failed, even when the push returned normally', async () => {
    const quiet = engine(status('full', true), async () => {});
    expect(await pushBeforeStop(quiet, 1000, async () => false)).toBe('failed');
    const throwing = engine(status('full', true), async () => {
      throw new Error('rejected');
    });
    expect(await pushBeforeStop(throwing, 1000, async () => false)).toBe('failed');
  });

  test('gives up after its time, and at once when no time is left', async () => {
    const stuck = engine(status('full', true), () => new Promise<void>(() => {}));
    expect(await pushBeforeStop(stuck, 20, async () => true)).toBe('timeout');
    expect(await pushBeforeStop(stuck, 0, async () => true)).toBe('timeout');
  });
});
