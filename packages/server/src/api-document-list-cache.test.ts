import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { afterEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import type { FileIndexEntry } from './file-watcher.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function entry(path: string): FileIndexEntry {
  return {
    size: 7,
    modified: '2026-11-27T10:00:00.000Z',
    canonicalPath: path,
    inode: '',
    aliases: [],
    kind: 'markdown',
  };
}

function rig() {
  const tmp = mkdtempSync(join(tmpdir(), 'gq-document-list-cache-'));
  dirs.push(tmp);
  writeFileSync(join(tmp, 'log.md'), '# Log\n', 'utf-8');
  writeFileSync(join(tmp, 'notes.md'), '# Notes\n', 'utf-8');
  const fileIndex = new Map<string, FileIndexEntry>([['log', entry(join(tmp, 'log.md'))]]);
  let generation = 1;
  const ext = createApiExtension({
    hocuspocus: new Hocuspocus({ quiet: true }),
    sessionManager: {
      closeSession: async () => {},
      closeAllForDoc: async () => {},
    } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir: tmp,
    getFileIndex: () => fileIndex,
    getFolderIndex: () => new Map(),
    getFileIndexGeneration: () => generation,
    serverInstanceId: 'test-instance',
  });
  const ask = async (headers: Record<string, string> = {}): Promise<Answer> => {
    const req = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
    req.method = 'GET';
    req.url = '/api/documents';
    req.headers = { host: 'localhost', ...headers };
    const answer: Answer = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status: number, head: Record<string, string> = {}) {
        answer.status = status;
        answer.headers = head;
      },
      end(body?: string) {
        answer.body = body ?? '';
      },
    } as unknown as ServerResponse;
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
    return answer;
  };
  const names = (answer: Answer) =>
    (JSON.parse(answer.body) as { documents: Array<{ docName?: string }> }).documents
      .map((d) => d.docName)
      .filter((n) => n !== undefined)
      .sort();
  return {
    ask,
    names,
    change: (name: string) => {
      fileIndex.set(name, entry(join(tmp, `${name}.md`)));
      generation += 1;
    },
  };
}

describe('page list answered from the index generation', () => {
  test('carries an ETag, answers 304 while nothing changed, and a new list after a change', async () => {
    const r = rig();
    const first = await r.ask();
    expect(first.status).toBe(200);
    expect(r.names(first)).toEqual(['log']);
    const etag = first.headers.ETag;
    expect(etag).toMatch(/^W\/"documents-[0-9a-f]+-1"$/);
    expect(first.headers['Cache-Control']).toBe('no-cache');

    const again = await r.ask();
    expect(again.body).toBe(first.body);
    expect((await r.ask({ 'if-none-match': etag ?? '' })).status).toBe(304);

    r.change('notes');
    const stale = await r.ask({ 'if-none-match': etag ?? '' });
    expect(stale.status).toBe(200);
    expect(r.names(stale)).toEqual(['log', 'notes']);
    expect(stale.headers.ETag).not.toBe(etag);
  });
});
