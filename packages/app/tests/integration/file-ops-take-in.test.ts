import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

const servers: TestServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.cleanup().catch(() => {});
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElEQrkJggg==',
  'base64',
);

async function bootWithGuide(): Promise<TestServer> {
  const server = await createTestServer();
  servers.push(server);
  mkdirSync(join(server.contentDir, 'docs'), { recursive: true });
  writeFileSync(join(server.contentDir, 'docs', 'guide.md'), '# Guide\n');
  await post(server, '/api/documents/reread', {});
  return server;
}

async function post(server: TestServer, route: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function listedPaths(server: TestServer): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
  const body = (await res.json()) as { documents?: Array<{ path?: string }> };
  return (body.documents ?? []).map((entry) => entry.path ?? '');
}

async function upload(server: TestServer): Promise<string> {
  const form = new FormData();
  form.append('parentDocName', 'docs/guide.md');
  form.append('file', new Blob([PNG]), 'shot.png');
  const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

describe('file operations show up without a watcher', () => {
  test(
    'an uploaded file is listed as soon as the upload answers',
    async () => {
      const server = await bootWithGuide();
      const path = await upload(server);
      expect(await listedPaths(server)).toContain(path);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'renaming and deleting an uploaded file updates the list',
    async () => {
      const server = await bootWithGuide();
      const path = await upload(server);
      const renamedPath = 'docs/guide.assets/renamed.png';
      const renamed = await post(server, '/api/rename-path', {
        kind: 'asset',
        fromPath: path,
        toPath: renamedPath,
      });
      expect(renamed.status).toBe(200);
      const afterRename = await listedPaths(server);
      expect(afterRename).toContain(renamedPath);
      expect(afterRename).not.toContain(path);

      const deleted = await post(server, '/api/delete-path', { kind: 'asset', path: renamedPath });
      expect(deleted.status).toBe(200);
      expect(await listedPaths(server)).not.toContain(renamedPath);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});
