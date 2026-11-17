import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bindConfigDoc, CONFIG_DOC_NAME_PROJECT, type ConfigBinding } from '@gitquire/core';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  createSyncWiredTestServer,
  createTestClient,
  pollUntil,
  type SyncWiredTestServer,
  serializeFragment,
  type TestClient,
} from './test-harness';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

function replaceParagraphText(client: TestClient, from: string, to: string): void {
  client.fragment.doc?.transact(() => {
    for (const node of client.fragment.toArray()) {
      if (!(node instanceof Y.XmlElement)) continue;
      const text = node.toArray().find((child) => child instanceof Y.XmlText);
      if (!(text instanceof Y.XmlText)) continue;
      const current = text.toString();
      const at = current.indexOf(from);
      if (at === -1) continue;
      text.delete(at, from.length);
      text.insert(at, to);
      return;
    }
    throw new Error(`no paragraph contains ${from}`);
  });
}

async function documentNames(server: SyncWiredTestServer): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
  const body = (await res.json()) as { documents?: Array<{ docName: string }> };
  return (body.documents ?? []).map((document) => document.docName);
}

async function folderPaths(server: SyncWiredTestServer): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
  const body = (await res.json()) as { documents?: Array<{ kind?: string; path?: string }> };
  return (body.documents ?? [])
    .filter((entry) => entry.kind === 'folder')
    .map((entry) => entry.path ?? '');
}

async function backlinksOf(server: SyncWiredTestServer, docName: string): Promise<string[]> {
  const res = await fetch(
    `http://127.0.0.1:${server.port}/api/backlinks?docName=${encodeURIComponent(docName)}`,
  );
  const body = (await res.json()) as { backlinks?: Array<{ docName?: string; source?: string }> };
  return (body.backlinks ?? []).map((link) => link.docName ?? link.source ?? '');
}

describe('a pull', () => {
  const servers: SyncWiredTestServer[] = [];
  const clients: TestClient[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const client of clients.splice(0)) await client.cleanup().catch(() => {});
    for (const server of servers.splice(0)) await server.cleanup().catch(() => {});
  });

  async function serverWith(originSeed: Record<string, string>): Promise<SyncWiredTestServer> {
    const server = await createSyncWiredTestServer({
      mode: 'follow',
      originSeed: { '.gitquire/config.yml': '{}\n', ...originSeed },
      projectConfigYml: originSeed['.gitquire/config.yml'] ?? '{}\n',
    });
    servers.push(server);
    return server;
  }

  async function openDoc(server: SyncWiredTestServer, docName: string, text: string) {
    const client = await createTestClient(server.port, docName);
    clients.push(client);
    await pollUntil(() => serializeFragment(client.fragment).includes(text));
    return client;
  }

  test(
    'shows the new text in an open page nobody edited',
    async () => {
      const server = await serverWith({ 'guide.md': '# Guide\n\nversion one\n' });
      const client = await openDoc(server, 'guide', 'version one');

      await server.sync.pushToOrigin({ 'guide.md': '# Guide\n\nversion two from origin\n' });
      await server.sync.engine.trigger('pull');

      await pollUntil(() => serializeFragment(client.fragment).includes('version two from origin'));
      expect(serializeFragment(client.fragment)).not.toContain('version one');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'keeps an edit made elsewhere in the open page next to the pulled change',
    async () => {
      const server = await serverWith({
        'guide.md': '# Guide\n\nfirst paragraph\n\nsecond paragraph\n',
      });
      const client = await openDoc(server, 'guide', 'second paragraph');
      appendParagraph(client, 'typed in the browser');
      await pollUntil(() =>
        readFileSync(join(server.contentDir, 'guide.md'), 'utf-8').includes('typed in the browser'),
      );

      await server.sync.pushToOrigin({
        'guide.md': '# Guide\n\nfirst paragraph changed on GitHub\n\nsecond paragraph\n',
      });
      await server.sync.engine.trigger('pull');

      await pollUntil(() =>
        serializeFragment(client.fragment).includes('first paragraph changed on GitHub'),
      );
      expect(serializeFragment(client.fragment)).toContain('typed in the browser');
      await pollUntil(() => {
        const onDisk = readFileSync(join(server.contentDir, 'guide.md'), 'utf-8');
        return (
          onDisk.includes('first paragraph changed on GitHub') &&
          onDisk.includes('typed in the browser')
        );
      });
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'keeps an edit that is not on disk yet when the pull starts',
    async () => {
      const server = await serverWith({
        'guide.md': '# Guide\n\nfirst paragraph\n\nsecond paragraph\n',
      });
      await server.sync.pushToOrigin({
        'guide.md': '# Guide\n\nfirst paragraph changed on GitHub\n\nsecond paragraph\n',
      });
      const client = await openDoc(server, 'guide', 'second paragraph');
      appendParagraph(client, 'typed just before the pull');
      await server.sync.engine.trigger('pull');

      await pollUntil(() =>
        serializeFragment(client.fragment).includes('first paragraph changed on GitHub'),
      );
      expect(serializeFragment(client.fragment)).toContain('typed just before the pull');
      await pollUntil(() => {
        const onDisk = readFileSync(join(server.contentDir, 'guide.md'), 'utf-8');
        return (
          onDisk.includes('first paragraph changed on GitHub') &&
          onDisk.includes('typed just before the pull')
        );
      });
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'adds and removes folders the pull adds and empties',
    async () => {
      const server = await serverWith({
        'old/one.md': '# One\n\nold\n',
        'old/two.md': '# Two\n\nold\n',
      });
      await pollUntil(async () => (await folderPaths(server)).includes('old'));

      await server.sync.pushToOrigin({ 'notes/new/page.md': '# Page\n\nnew\n' });
      await server.sync.removeFromOrigin(['old/one.md', 'old/two.md']);
      await server.sync.engine.trigger('pull');

      await pollUntil(async () => (await documentNames(server)).includes('notes/new/page'));
      await pollUntil(async () => {
        const folders = await folderPaths(server);
        return folders.includes('notes/new') && !folders.includes('old');
      });
      const folders = await folderPaths(server);
      expect(folders).toContain('notes/new');
      expect(folders).not.toContain('old');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'raises a conflict and loses nothing when the pull changes the passage being edited',
    async () => {
      const server = await serverWith({ 'guide.md': '# Guide\n\nthe shared sentence\n' });
      const client = await openDoc(server, 'guide', 'the shared sentence');
      replaceParagraphText(client, 'the shared sentence', 'the sentence as typed here');
      await pollUntil(() =>
        readFileSync(join(server.contentDir, 'guide.md'), 'utf-8').includes(
          'the sentence as typed here',
        ),
      );

      await server.sync.pushToOrigin({
        'guide.md': '# Guide\n\nthe sentence as written on GitHub\n',
      });
      await server.sync.engine.trigger('pull');

      await pollUntil(() => server.instance.conflicts.list().length > 0);
      expect(serializeFragment(client.fragment)).toContain('the sentence as typed here');
      const theirs = await fetch(
        `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=guide.md`,
      );
      expect(theirs.status).toBe(200);
      expect(((await theirs.json()) as { theirs: string }).theirs).toContain(
        'the sentence as written on GitHub',
      );
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'follows pages the pull renames, deletes and adds in the page list and backlinks',
    async () => {
      const server = await serverWith({
        'alpha.md': '# Alpha\n\nSee [[beta]].\n',
        'beta.md': '# Beta\n\nbeta body\n',
        'gamma.md': '# Gamma\n\ngoing away\n',
      });
      await pollUntil(async () => (await backlinksOf(server, 'beta')).includes('alpha'));

      await server.sync.pushToOrigin({
        'alpha.md': '# Alpha\n\nSee [[renamed-beta]].\n',
        'renamed-beta.md': '# Beta\n\nbeta body\n',
        'delta.md': '# Delta\n\nSee [[renamed-beta]].\n',
      });
      await server.sync.removeFromOrigin(['beta.md', 'gamma.md']);
      await server.sync.engine.trigger('pull');

      await pollUntil(async () => {
        const names = await documentNames(server);
        return (
          names.includes('renamed-beta') &&
          names.includes('delta') &&
          !names.includes('beta') &&
          !names.includes('gamma')
        );
      });
      await pollUntil(async () => {
        const links = await backlinksOf(server, 'renamed-beta');
        return links.includes('alpha') && links.includes('delta');
      });
      expect(await backlinksOf(server, 'beta')).toEqual([]);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'takes in a pulled change to the project settings',
    async () => {
      const server = await serverWith({ 'guide.md': '# Guide\n\nbody\n' });
      const ydoc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${server.port}/collab`,
        name: CONFIG_DOC_NAME_PROJECT,
        document: ydoc,
        connect: true,
      });
      const binding: ConfigBinding = bindConfigDoc(provider, 'project');
      cleanups.push(() => {
        binding.dispose();
        provider.destroy();
        ydoc.destroy();
      });
      await pollUntil(() => binding.hasSynced(), 10_000);

      await server.sync.pushToOrigin({
        '.gitquire/config.yml': 'contentRules:\n  markdownlint:\n    enabled: true\n',
      });
      await server.sync.engine.trigger('pull');

      await pollUntil(() => binding.current().contentRules?.markdownlint?.enabled === true, 15_000);
      const templates = await fetch(`http://127.0.0.1:${server.port}/api/templates`);
      expect(templates.status).toBe(200);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'shows the GitHub text in the open page after the conflict is resolved with theirs',
    async () => {
      const server = await serverWith({ 'guide.md': '# Guide\n\nintro\n\noutro\n' });
      writeFileSync(join(server.contentDir, 'guide.md'), '# Guide\n\nLOCAL intro\n\noutro\n');
      await server.sync.pushToOrigin({ 'guide.md': '# Guide\n\nORIGIN intro\n\noutro\n' });
      await server.sync.engine.trigger('pull');
      expect(server.instance.conflicts.list()).toHaveLength(1);
      const client = await openDoc(server, 'guide', 'LOCAL intro');

      const resolved = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'guide.md', strategy: 'theirs' }),
      });
      expect(resolved.status).toBe(200);
      await pollUntil(() => serializeFragment(client.fragment).includes('ORIGIN intro'));
      expect(serializeFragment(client.fragment)).not.toContain('LOCAL intro');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'loads the other branch after a checkout',
    async () => {
      const server = await serverWith({ 'guide.md': '# Guide\n\non main\n' });
      await runGit(server.contentDir, ['checkout', '-q', '-b', 'notes']);
      writeFileSync(join(server.contentDir, 'guide.md'), '# Guide\n\non the notes branch\n');
      writeFileSync(join(server.contentDir, 'only-notes.md'), '# Notes\n\nnotes only\n');
      await runGit(server.contentDir, ['add', '-A']);
      await runGit(server.contentDir, ['commit', '-q', '-m', 'notes']);
      await runGit(server.contentDir, ['checkout', '-q', 'main']);
      const client = await openDoc(server, 'guide', 'on main');

      const checkout = await fetch(`http://127.0.0.1:${server.port}/api/git/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'notes' }),
      });
      expect(checkout.status).toBe(200);
      const { ok } = (await checkout.json()) as { ok: boolean };
      expect(ok).toBe(true);
      await pollUntil(() => serializeFragment(client.fragment).includes('on the notes branch'));
      await pollUntil(async () => (await documentNames(server)).includes('only-notes'));
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});

describe('re-reading from disk', () => {
  const servers: SyncWiredTestServer[] = [];
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.cleanup().catch(() => {});
    for (const server of servers.splice(0)) await server.cleanup().catch(() => {});
  });

  test(
    'takes in files changed directly on disk only when asked',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'follow',
        originSeed: { '.gitquire/config.yml': '{}\n', 'guide.md': '# Guide\n\nversion one\n' },
        projectConfigYml: '{}\n',
      });
      servers.push(server);
      const client = await createTestClient(server.port, 'guide');
      clients.push(client);
      await pollUntil(() => serializeFragment(client.fragment).includes('version one'));

      writeFileSync(join(server.contentDir, 'guide.md'), '# Guide\n\nwritten on the server\n');
      writeFileSync(join(server.contentDir, 'added.md'), '# Added\n\nnew page\n');
      await new Promise((settle) => setTimeout(settle, 500));
      expect(serializeFragment(client.fragment)).toContain('version one');
      expect(await documentNames(server)).not.toContain('added');

      const reread = await fetch(`http://127.0.0.1:${server.port}/api/documents/reread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(reread.status).toBe(200);
      const body = (await reread.json()) as { status: string; found: number };
      expect(body.status).toBe('completed');
      expect(body.found).toBeGreaterThan(0);
      await pollUntil(() => serializeFragment(client.fragment).includes('written on the server'));
      await pollUntil(async () => (await documentNames(server)).includes('added'));
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});
