import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { __formatContributorsForTests } from './contributor-tracker.ts';
import * as persistence from './persistence.ts';

test('test flush waits for accepted artifact attribution before acknowledging settlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-artifact-flush-settlement-'));
  mkdirSync(join(root, 'templates'));
  let server: BootedServer | undefined;
  let gated = false;
  let released = false;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  const gitFlushes: boolean[] = [];
  const create = persistence.createPersistenceExtension;
  vi.spyOn(persistence, 'createPersistenceExtension').mockImplementation((...args) => {
    const result = create(...args);
    const flush = result.flushContributors;
    const flushGit = result.flushPendingGitCommit;
    result.flushContributors = async () => {
      if (gated) {
        entered();
        await gate;
      }
      await flush();
    };
    result.flushPendingGitCommit = async () => {
      if (gated) gitFlushes.push(released);
      await flushGit();
    };
    return result;
  });
  try {
    server = await bootCompositionRig(root, { enableTestRoutes: true });
    await server.ready;
    await server.generatedIndexSweepReady;
    gated = true;
    const write = await rawRequest(server.port, '/api/template', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: 'templates',
        name: 'example',
        body: 'Safe.\n',
        frontmatter: { title: 'Example' },
      }),
    });
    expect(write.status, write.body).toBe(200);
    await started;
    expect(__formatContributorsForTests()).toContain('templates/.ok/templates/example');
    const { promise: requestReceived, resolve: received } = Promise.withResolvers<void>();
    server.httpServer.prependListener('request', (req) => {
      if (req.url === '/api/test-flush-git') received();
    });
    const flushing = rawRequest(server.port, '/api/test-flush-git', { method: 'POST' });
    await requestReceived;
    await setImmediate();
    const beforeRelease = [...gitFlushes];
    released = true;
    release();
    const response = await flushing;
    expect(beforeRelease).toEqual([]);
    expect(response.status, response.body).toBe(200);
    expect(gitFlushes).toEqual([true]);
    expect(__formatContributorsForTests()).toBe('');
  } finally {
    release();
    await server?.destroy();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
