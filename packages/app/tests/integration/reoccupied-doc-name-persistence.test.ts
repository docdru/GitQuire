import { execSync } from 'node:child_process';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { post } from './rename-rebinding.test-helper.ts';
import {
  awaitFileWatcherIndexed,
  createTestClient,
  createTestServer,
  pollUntil,
  readTestDoc,
  rereadFromDisk,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

const BODY = [
  '# Index',
  '',
  '| Name | Note |',
  '| --- | --- |',
  '| alpha | one |',
  '| omega | two |',
  '',
].join('\n');

const RECREATED_BODY = [
  '# Index',
  '',
  '| Name | Note |',
  '| --- | --- |',
  '| recreated | new |',
  '| omega | two |',
  '',
].join('\n');

let server: TestServer | undefined;
const clients: TestClient[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubEnv('GITQUIRE_NAMING', 'off');
  return () => vi.unstubAllEnvs();
});

afterEach(async () => {
  while (clients.length > 0)
    await clients
      .pop()
      ?.cleanup()
      .catch(() => {});
  await server?.cleanup().catch(() => {});
  server = undefined;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startWithOpenDoc(
  docName: string,
  otherDocs: Record<string, string> = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'ok-reoccupied-name-'));
  writeFileSync(join(dir, `${docName}.md`), BODY, 'utf-8');
  for (const [name, body] of Object.entries(otherDocs)) {
    writeFileSync(join(dir, `${name}.md`), body, 'utf-8');
  }
  const started = await createTestServer({ contentDir: dir });
  await awaitFileWatcherIndexed(started, docName);
  const client = await createTestClient(started.port, docName, { skipInvariantWatcher: true });
  clients.push(client);
  await pollUntil(() => client.ytext.toString().includes('| omega |'), 15_000);
  return started;
}

async function rereadRunning(): Promise<void> {
  if (!server) throw new Error('server not started');
  await rereadFromDisk(server);
}

function diskPath(docName: string): string {
  if (!server) throw new Error('server not started');
  return join(server.contentDir, `${docName}.md`);
}

function lifecycleStatus(docName: string): unknown {
  return server?.instance.hocuspocus.documents.get(docName)?.getMap('lifecycle').get('status');
}

function residentSource(docName: string): string | undefined {
  return server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString();
}

async function renameAwayOnDisk(docName: string, movedTo: string): Promise<void> {
  renameSync(diskPath(docName), diskPath(movedTo));
  await rereadRunning();
  await pollUntil(() => lifecycleStatus(docName) === 'renamed', 30_000, 100, 'the rename freeze');
}

async function expectOnDisk(contentDir: string, docName: string, text: string): Promise<void> {
  await pollUntil(
    () => readTestDoc(contentDir, docName).includes(text),
    30_000,
    100,
    `${docName}.md on disk to contain ${JSON.stringify(text)}`,
  );
}

function writeAsAgent(port: number, docName: string, markdown: string) {
  return post(port, '/api/agent-write-md', {
    docName,
    markdown,
    position: 'replace',
    agentId: 'reoccupied-name-test',
  });
}

function insertRowBeforeOmega(port: number, docName: string, row: string) {
  return post(port, '/api/agent-patch', {
    docName,
    find: '| omega |',
    replace: `${row}\n| omega |`,
    agentId: 'reoccupied-name-test',
  });
}

function _git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.local',
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

describe('a document name re-occupied after an on-disk rename keeps persisting edits', () => {
  test('a file re-created on disk replaces the frozen content and takes agent edits (PRD-9321)', async () => {
    server = await startWithOpenDoc('Index');

    await renameAwayOnDisk('Index', 'Index-backup');
    writeFileSync(diskPath('Index'), RECREATED_BODY, 'utf-8');
    await rereadRunning();
    await pollUntil(
      () => residentSource('Index') === RECREATED_BODY,
      30_000,
      100,
      'the re-created file to replace the frozen content',
    );

    const edit = await insertRowBeforeOmega(server.port, 'Index', '| after-recreate | b |');
    expect(edit.status).toBe(200);
    await expectOnDisk(server.contentDir, 'Index', '| after-recreate | b |');
    expect(readTestDoc(server.contentDir, 'Index')).toContain('| recreated | new |');
  }, 120_000);

  test('a page re-created through create-page starts from its new file and persists edits (PRD-9329)', async () => {
    server = await startWithOpenDoc('Post');

    await renameAwayOnDisk('Post', 'Post-moved');
    const created = await post(server.port, '/api/create-page', { path: 'Post.md' });
    expect(created.status).toBeLessThan(300);
    expect(residentSource('Post')).toBe('');

    const write = await writeAsAgent(server.port, 'Post', '# Typed after re-create\n');
    expect(write.status).toBe(200);
    await expectOnDisk(server.contentDir, 'Post', '# Typed after re-create');
  }, 120_000);

  test('a managed rename onto the frozen name takes over that name and persists edits', async () => {
    server = await startWithOpenDoc('Note', { Draft: RECREATED_BODY });

    await renameAwayOnDisk('Note', 'Note-moved');
    const renamed = await post(server.port, '/api/rename-path', {
      kind: 'file',
      fromPath: 'Draft.md',
      toPath: 'Note.md',
    });
    expect(renamed.status).toBe(200);
    await pollUntil(
      () => residentSource('Note') === RECREATED_BODY,
      15_000,
      100,
      'the renamed file to replace the frozen content',
    );

    const edit = await insertRowBeforeOmega(server.port, 'Note', '| after-managed-rename | c |');
    expect(edit.status).toBe(200);
    await expectOnDisk(server.contentDir, 'Note', '| after-managed-rename | c |');
  }, 120_000);

  test('an agent write to a renamed-away name that is still absent is refused with its new path', async () => {
    server = await startWithOpenDoc('Gone');

    await renameAwayOnDisk('Gone', 'Gone-moved');

    const write = await writeAsAgent(server.port, 'Gone', '# Written to the old name\n');
    expect(write.status).toBe(409);
    expect(write.body).toMatchObject({
      type: 'urn:ok:error:doc-removed',
      title: 'Edit applied in memory; disk write refused because the document was renamed.',
      detail: expect.stringContaining('re-read the document at Gone-moved'),
    });
    expect(readTestDoc(server.contentDir, 'Gone')).toBe('');
  }, 120_000);
});
