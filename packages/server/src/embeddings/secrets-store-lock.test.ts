import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createEmbeddingsSecretStore } from './secrets-store.ts';

const OPENAI = 'https://api.openai.com/v1';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ok-secrets-lock-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('two stores sharing a secrets file serialize their writes without losing either key', async () => {
  const path = join(dir, 'secrets.yml');
  const first = createEmbeddingsSecretStore(path);
  const second = createEmbeddingsSecretStore(path);
  await Promise.all([
    first.setForProject('/one', OPENAI, 'first-secret'),
    second.setForProject('/two', OPENAI, 'second-secret'),
  ]);
  expect(await first.listProjects()).toHaveLength(2);
  expect((await second.resolveForProject('/one', OPENAI)).key).toBe('first-secret');
  expect((await first.resolveForProject('/two', OPENAI)).key).toBe('second-secret');
});

test('a held lock reports lock_timeout, and a killed holder releases it', async () => {
  const path = join(dir, 'secrets.yml');
  await createEmbeddingsSecretStore(path).setForProject('/seed', OPENAI, 'seed-secret');
  const helper = fileURLToPath(new URL('./secrets-lock-holder.test-helper.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', helper, path], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<NodeJS.Signals | null>();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes('READY\n')) ready.resolve();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once('error', (error) => ready.reject(error));
  child.once('close', (code, signal) => {
    closed.resolve(signal);
    ready.reject(new Error(`Lock holder exited before readiness: ${code ?? signal}; ${stderr}`));
  });
  try {
    await ready.promise;
    const contention = await createEmbeddingsSecretStore(path)
      .setForProject('/blocked', OPENAI, 'blocked-secret')
      .catch((error: unknown) => error);
    expect(contention, stderr).toMatchObject({ code: 'lock_timeout' });
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed.promise).toBe('SIGKILL');
    const survivor = createEmbeddingsSecretStore(path);
    await survivor.setForProject('/survivor', OPENAI, 'survivor-secret');
    expect((await survivor.resolveForProject('/survivor', OPENAI)).key).toBe('survivor-secret');
    expect((await survivor.resolveForProject('/seed', OPENAI)).key).toBe('seed-secret');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}, 30_000);
