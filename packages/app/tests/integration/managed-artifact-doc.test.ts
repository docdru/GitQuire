import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestClient, createTestServer, type TestServer } from './test-harness.ts';

describe('template CRDT docs — end to end', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });

  async function pollFor(path: string, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(path)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return existsSync(path);
  }

  test('a template content doc persists to <folder>/.gitquire/templates/<name>.md', async () => {
    const docName = '.gitquire/templates/daily-note';
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });

    const src = '---\ntitle: Daily Note\ndescription: a daily note\n---\n\n# {{date}}\n\nNotes.\n';
    client.doc.transact(() => client.ytext.insert(0, src));

    const tplFile = resolve(server.contentDir, '.gitquire', 'templates', 'daily-note.md');
    expect(await pollFor(tplFile)).toBe(true);
    expect(readFileSync(tplFile, 'utf-8')).toBe(src);

    await client.cleanup();
  });

  test('PUT /api/template routes the body through the open CRDT doc (Slice E)', async () => {
    const docName = 'notes/.gitquire/templates/meeting';
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: 'notes',
        name: 'meeting',
        body: '# Agenda\n\n- item\n',
        frontmatter: { title: 'Meeting', description: 'Use for meeting notes.' },
      }),
    });
    expect(res.status).toBe(200);

    const expected =
      '---\ntemplate:\n  title: Meeting\n  description: Use for meeting notes.\n---\n# Agenda\n\n- item\n';
    const start = Date.now();
    while (Date.now() - start < 5000 && client.ytext.toString() !== expected) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(client.ytext.toString()).toBe(expected);

    const tplFile = resolve(server.contentDir, 'notes', '.gitquire', 'templates', 'meeting.md');
    expect(await pollFor(tplFile)).toBe(true);
    expect(readFileSync(tplFile, 'utf-8')).toBe(expected);

    await client.cleanup();
  });

  test('an external template .md disk edit reconciles into the open doc', async () => {
    await server.cleanup();
    const seedDir = mkdtempSync(join(tmpdir(), 'ok-template-reconcile-'));
    mkdirSync(resolve(seedDir, '.gitquire'), { recursive: true });
    writeFileSync(resolve(seedDir, '.gitquire', 'config.yml'), '', 'utf-8');
    const tplFile = resolve(seedDir, '.gitquire', 'templates', 'daily.md');
    const src = '---\ntitle: Daily\ndescription: initial\n---\n\n# {{date}}\n';
    mkdirSync(resolve(tplFile, '..'), { recursive: true });
    writeFileSync(tplFile, src, 'utf-8');
    server = await createTestServer({ contentDir: seedDir });

    const docName = '.gitquire/templates/daily';
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    const loadStart = Date.now();
    while (Date.now() - loadStart < 5000 && client.ytext.toString() !== src) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(client.ytext.toString()).toBe(src);

    const edited =
      '---\ntitle: Daily\ndescription: edited externally\n---\n\n# {{date}}\n\nMore.\n';
    const start = Date.now();
    while (Date.now() - start < 15000 && client.ytext.toString() !== edited) {
      writeFileSync(tplFile, edited, 'utf-8');
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(client.ytext.toString()).toBe(edited);

    await client.cleanup();
  }, 30_000);
});
