import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireServerLock, releaseServerLock, resolveLockDir } from '@gitquire/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReread } from './reread.ts';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'gq-reread-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  releaseServerLock(resolveLockDir(projectDir));
  rmSync(projectDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('gq reread', () => {
  it('asks the running server to re-read the content folder', async () => {
    acquireServerLock(resolveLockDir(projectDir), { port: 4321, worktreeRoot: projectDir });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: 'completed', found: 2 }), { status: 200 }),
    );
    await runReread({ json: false, fetchImpl }, projectDir);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/api/documents/reread',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('fails when no server is running', async () => {
    await expect(runReread({ json: false }, projectDir)).rejects.toThrow(
      'No running GitQuire server',
    );
  });

  it('reports the server error', async () => {
    acquireServerLock(resolveLockDir(projectDir), { port: 4321, worktreeRoot: projectDir });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ title: 'Nope.' }), { status: 503 }),
    );
    await expect(runReread({ json: false, fetchImpl }, projectDir)).rejects.toThrow('Nope.');
  });
});
