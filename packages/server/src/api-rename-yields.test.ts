import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import { BacklinkIndex } from './backlink-index.ts';
import type { FileIndexEntry } from './file-watcher.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('renaming a page that many pages link to', () => {
  test('rewrites every linking page and lets other work run while it does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gq-rename-yields-'));
    dirs.push(dir);
    const index = new Map<string, FileIndexEntry>();
    const add = (name: string, text: string) => {
      const path = join(dir, `${name}.md`);
      writeFileSync(path, text, 'utf-8');
      const stat = statSync(path);
      index.set(name, { size: stat.size, modified: stat.mtime.toISOString() });
    };
    add('hub', '# Hub\n');
    const linking = 1500;
    for (let i = 0; i < linking; i++) {
      add(`page-${i}`, `# Page ${i}\n\n${'Some text. '.repeat(60)}\n\nSee [[hub]] and [[hub]].\n`);
    }
    const backlinkIndex = new BacklinkIndex({ projectDir: dir, contentDir: dir });
    await backlinkIndex.rebuildFromDisk();
    const ext = createApiExtension({
      hocuspocus: {
        documents: new Map(),
        closeConnections() {},
        unloadDocument: async () => {},
        debouncer: {
          isDebounced: () => false,
          isCurrentlyExecuting: () => false,
          executeNow: async () => undefined,
        },
      } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async () => {},
      } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
      contentDir: dir,
      getFileIndex: () => index,
      backlinkIndex,
    });
    const body = JSON.stringify({ kind: 'file', fromPath: 'hub.md', toPath: 'center.md' });
    const req = Readable.from(Buffer.from(body)) as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = '/api/rename-path';
    req.headers = { host: 'localhost' };
    const captured = { status: 0, body: '' };
    const res = {
      writeHead(status: number) {
        captured.status = status;
      },
      end(text?: string) {
        captured.body = text ?? '';
      },
    } as unknown as ServerResponse;

    let longestGapMs = 0;
    let last = performance.now();
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longestGapMs = Math.max(longestGapMs, now - last);
      last = now;
      ticks += 1;
    }, 5);
    const started = performance.now();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
    const tookMs = performance.now() - started;
    clearInterval(timer);

    expect(captured.status).toBe(200);
    for (let i = 0; i < linking; i++) {
      expect(readFileSync(join(dir, `page-${i}.md`), 'utf-8')).toContain(
        '[[center|hub]] and [[center|hub]]',
      );
    }
    if (tookMs > 300) {
      expect(ticks).toBeGreaterThan(2);
      expect(longestGapMs).toBeLessThan(tookMs * 0.6);
    }
  }, 60_000);
});
