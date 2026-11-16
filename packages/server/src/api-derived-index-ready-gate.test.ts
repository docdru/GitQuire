import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { createContentFilter } from './content-filter.ts';
import { DerivedDocumentIndex } from './derived-document-index.ts';

interface PendingRoute {
  captured: { status: number; body: string };
  done: Promise<void>;
}

function startRoute(
  extension: ReturnType<typeof createApiExtension>,
  url: string,
  method = 'GET',
  body?: unknown,
): PendingRoute {
  const request = Readable.from(
    Buffer.from(body === undefined ? '' : JSON.stringify(body)),
  ) as unknown as IncomingMessage;
  request.method = method;
  request.url = url;
  request.headers = { host: 'localhost' };
  const captured = { status: 0, body: '' };
  const response = {
    writeHead(status: number) {
      captured.status = status;
    },
    setHeader() {},
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  const done = (
    extension as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request, response });
  return { captured, done };
}

describe('derived-index API readiness gate', () => {
  test('backlink and tag queries wait for post-watcher startup settlement', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-derived-ready-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, 'source.md'), 'See [[target]]. #startup\n');
    const index = new DerivedDocumentIndex({
      projectDir,
      contentDir,
      contentFilter: createContentFilter({ projectDir, contentDir }),
      signalChannel: () => {},
    });

    try {
      const startup = index.beginStartup('main');
      const extension = createApiExtension({
        hocuspocus: {} as never,
        sessionManager: {} as never,
        contentDir,
        getFileIndex: () => new Map(),
        derivedDocumentIndex: index,
      });
      const backlinksRoute = startRoute(extension, '/api/backlinks?docName=target');
      const tagsRoute = startRoute(extension, '/api/tags/startup');

      await startup.backlinksReady;
      await Promise.resolve();
      expect(backlinksRoute.captured.status).toBe(0);
      expect(tagsRoute.captured.status).toBe(0);

      await index.settleStartupAfterWatcherSeed();
      await Promise.all([backlinksRoute.done, tagsRoute.done]);

      expect(backlinksRoute.captured.status).toBe(200);
      expect(JSON.parse(backlinksRoute.captured.body)).toMatchObject({
        docName: 'target',
        backlinks: [{ source: 'source' }],
      });
      expect(tagsRoute.captured.status).toBe(200);
      expect(JSON.parse(tagsRoute.captured.body)).toMatchObject({
        name: 'startup',
        docs: [{ docName: 'source', matchingTags: ['startup'] }],
      });
    } finally {
      await index.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('test rescan retains the route-level 500 boundary for coordinator failures', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-derived-rescan-error-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const index = new DerivedDocumentIndex({
      projectDir,
      contentDir,
      contentFilter: createContentFilter({ projectDir, contentDir }),
      signalChannel: () => {},
    });

    try {
      const startup = index.beginStartup('main');
      await startup.backlinksReady;
      await index.settleStartupAfterWatcherSeed();
      vi.spyOn(BacklinkIndex.prototype, 'rebuildFromDisk').mockRejectedValueOnce(
        new Error('global rescan failure'),
      );
      const extension = createApiExtension({
        hocuspocus: {} as never,
        sessionManager: {} as never,
        contentDir,
        getFileIndex: () => new Map(),
        derivedDocumentIndex: index,
        enableTestRoutes: true,
      });

      const route = startRoute(extension, '/api/test-rescan-backlinks', 'POST');
      await route.done;

      expect(route.captured.status).toBe(500);
      expect(JSON.parse(route.captured.body)).toMatchObject({
        type: 'urn:ok:error:internal-server-error',
      });
    } finally {
      vi.restoreAllMocks();
      await index.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
