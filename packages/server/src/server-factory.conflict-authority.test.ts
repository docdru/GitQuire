import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  DocumentListSuccessSchema,
  DocumentReadSuccessSchema,
  GQ_DIR,
  SyncConflictsSuccessSchema,
} from '@gitquire/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { bootServer } from '../../../test-support/boot-server.test-helper.ts';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { ConfigSchema } from './config/schema.ts';
import type { ServerInstance } from './server-factory.ts';

const execFileAsync = promisify(execFile);
const TEST_CONFIG = ConfigSchema.parse({});

const DOC_NAME = 'notes/topic';
const DOC_FILE = 'notes/topic.md';
const SCRATCH_DOC = 'notes/scratch';
const SCRATCH_FILE = 'notes/scratch.md';
const COLLISION_FILE = 'notes/pull-collision.md';
const CONTROL_MARKER = 'stored while the batch was down';
const DEFERRED_MARKER = 'drained by the resolve';

function seedOkScaffold(projectDir: string): void {
  const okDir = resolve(projectDir, GQ_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(resolve(okDir, '.gitignore'), 'local/\n', 'utf-8');
}

function seedConflictsJson(projectDir: string, file: string): void {
  const localDir = resolve(projectDir, GQ_DIR, 'local');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(
    resolve(localDir, 'conflicts.json'),
    JSON.stringify(
      {
        version: 1,
        branch: 'main',
        conflicts: [{ kind: 'merge-native', file, detectedAt: '2026-05-19T00:00:00.000Z' }],
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function seedRealMergeConflict(projectDir: string, filePath: string): Promise<void> {
  const opts = { cwd: projectDir };
  await execFileAsync('git', ['config', 'maintenance.auto', 'false'], opts);
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], opts);
  await execFileAsync('git', ['config', 'user.name', 'Test'], opts);
  mkdirSync(resolve(projectDir, 'notes'), { recursive: true });
  writeFileSync(resolve(projectDir, filePath), 'line1\nline2\nline3\n', 'utf-8');
  await execFileAsync('git', ['add', '-A'], opts);
  await execFileAsync('git', ['commit', '-m', 'base'], opts);
  await execFileAsync('git', ['checkout', '-b', 'theirs-branch'], opts);
  writeFileSync(resolve(projectDir, filePath), 'line1\nUPSTREAM\nline3\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'theirs'], opts);
  await execFileAsync('git', ['checkout', 'main'], opts);
  writeFileSync(resolve(projectDir, filePath), 'line1\nLOCAL\nline3\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'ours'], opts);
  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {});
  if (!existsSync(resolve(projectDir, '.git', 'MERGE_HEAD'))) {
    throw new Error('seedRealMergeConflict: no MERGE_HEAD — the merge did not conflict');
  }
}

async function isIndexed(port: number, docName: string): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/api/documents`);
  expect(res.ok).toBe(true);
  const data = DocumentListSuccessSchema.parse(await res.json());
  return data.documents.some((d) => d.docName === docName);
}

async function listConflictFiles(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync/conflicts`);
  expect(res.ok).toBe(true);
  const data = SyncConflictsSuccessSchema.parse(await res.json());
  return data.conflicts.map((c) => c.file);
}

interface ProbeAnswer {
  status: number;
  outcome: unknown;
}

async function writeDocProbe(
  port: number,
  docName: string,
  markdown: string,
): Promise<ProbeAnswer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, markdown, position: 'replace', agentId: 'probe' }),
  });
  const body = (await res.json()) as { outcome?: unknown };
  return { status: res.status, outcome: body.outcome };
}

function expectAdmitted(answer: ProbeAnswer): void {
  expect(answer).toEqual(
    answer.status === 503
      ? { status: 503, outcome: 'projection-held' }
      : { status: 200, outcome: 'applied' },
  );
}

async function resolveConflictOverHttp(
  port: number,
  file: string,
  strategy: string,
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync/resolve-conflict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, strategy }),
  });
  return res.status;
}

async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await wait(200);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

let tmpDir: string;
const pendingTeardown: Promise<void> = Promise.resolve();

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-conflict-authority-'));
});

afterEach(async () => {
  await pendingTeardown;
  await rm(tmpDir, { recursive: true, force: true });
});

async function bootWithHeldConflictedDoc(options?: {
  extraFiles?: Record<string, string>;
  load?: boolean;
}): Promise<{
  port: number;
  serverInstance: ServerInstance;
  destroy: () => Promise<void>;
  release: () => Promise<void>;
  readSource: () => Promise<string>;
}> {
  const contentDir = tmpDir;
  await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
  configureTestGitRepository(contentDir);
  seedOkScaffold(contentDir);
  for (const [file, body] of Object.entries(options?.extraFiles ?? {})) {
    const abs = resolve(contentDir, file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }
  await seedRealMergeConflict(contentDir, DOC_FILE);
  seedConflictsJson(contentDir, DOC_FILE);

  const booted = await bootServer({
    config: TEST_CONFIG,
    contentDir,
    port: 0,
    quiet: true,
    gitEnabled: false,
    idleShutdownMs: null,
  });

  const dc =
    options?.load === false
      ? null
      : await booted.serverInstance.hocuspocus.openDirectConnection(DOC_NAME);
  await pollUntil(
    () => isIndexed(booted.port, DOC_NAME),
    30_000,
    'the initial file-watcher scan to index the conflicted doc',
  );
  return {
    port: booted.port,
    serverInstance: booted.serverInstance,
    destroy: async () => {
      await booted.destroy();
    },
    release: async () => {
      await dc?.disconnect();
    },
    readSource: async () => {
      const res = await fetch(
        `http://127.0.0.1:${booted.port}/api/document?docName=${encodeURIComponent(DOC_NAME)}`,
      );
      expect(res.ok).toBe(true);
      return DocumentReadSuccessSchema.parse(await res.json()).content;
    },
  };
}

describe('a merge-native conflict resolved over HTTP unfreezes the loaded doc', () => {
  test('a resolve over HTTP drains the stores the batch deferred, with no manual flush', async () => {
    const held = await bootWithHeldConflictedDoc({
      extraFiles: { [SCRATCH_FILE]: 'scratch base\n', [COLLISION_FILE]: 'overlay\n' },
    });
    const readScratch = () => readFileSync(resolve(tmpDir, SCRATCH_FILE), 'utf-8');
    try {
      await pollUntil(
        () => isIndexed(held.port, SCRATCH_DOC),
        30_000,
        'the initial file-watcher scan to index the scratch doc',
      );

      expectAdmitted(await writeDocProbe(held.port, SCRATCH_DOC, `# ${CONTROL_MARKER}\n`));
      await pollUntil(
        () => readScratch().includes(CONTROL_MARKER),
        30_000,
        'an undeferred store to reach disk',
      );

      held.serverInstance.conflicts.raise({
        kind: 'working-tree',
        file: COLLISION_FILE,
        theirsSha: '0'.repeat(40),
      });

      held.serverInstance.durabilityState.setBatchInProgress(true);
      const scratch = await held.serverInstance.hocuspocus.openDirectConnection(SCRATCH_DOC);
      try {
        await scratch.transact((doc) => {
          const paragraph = new Y.XmlElement('paragraph');
          paragraph.insert(0, [new Y.XmlText(DEFERRED_MARKER)]);
          doc.getXmlFragment('default').push([paragraph]);
        });
        const debounceId = `onStoreDocument-${SCRATCH_DOC}`;
        await pollUntil(
          () => held.serverInstance.hocuspocus.debouncer.isDebounced(debounceId),
          15_000,
          'the edit to schedule a store',
        );
        await held.serverInstance.hocuspocus.debouncer.executeNow(debounceId);
      } finally {
        await scratch.disconnect();
      }
      expect(readScratch()).toContain(CONTROL_MARKER);
      expect(readScratch()).not.toContain(DEFERRED_MARKER);

      expect(await listConflictFiles(held.port)).toContain(COLLISION_FILE);
      expect(await resolveConflictOverHttp(held.port, COLLISION_FILE, 'mine')).toBe(200);

      await pollUntil(
        () => readScratch().includes(DEFERRED_MARKER),
        30_000,
        'the resolve route to drain the deferred store to disk',
      );
    } finally {
      await held.release();
      await held.destroy();
    }
  }, 180_000);
});
