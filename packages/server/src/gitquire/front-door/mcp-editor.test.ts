import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../config/schema.ts';
import { createMcpHttpHandler } from '../../mcp-http.ts';
import { createBehindFrontDoorGate } from '../behind-front-door-gate.ts';
import { internalSecret } from '../internal-request.ts';
import type { OpenDecision } from './access.ts';
import { createDoorMcp } from './mcp.ts';
import type { WikiRecord } from './wiki-table.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const alice = { id: 11, login: 'alice', name: 'Alice', avatarUrl: '' };
const wiki: WikiRecord = {
  host: 'github',
  id: 1,
  owner: 'team',
  ownerId: 7,
  name: 'a',
  key: 'github-1',
  state: 'on',
  formerNames: [],
  addedBy: 'alice',
  addedAt: '',
};

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

function listenOnSocket(server: Server, socket: string): Promise<void> {
  return new Promise((resolve) => {
    server.listen(socket, () => resolve());
  });
}

async function editorOnSocket(): Promise<{ socket: string; seen: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'gq-door-editor-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, 'wiki.sock');
  const seen: string[] = [];
  const gate = createBehindFrontDoorGate(
    { repo: 'team/a', adminLogins: new Set(), aiChat: false },
    { log: silentLog },
  );
  const mcp = createMcpHttpHandler({
    contentDir: dir,
    projectDir: dir,
    config: ConfigSchema.parse({}),
    getServerUrl: () => 'http://127.0.0.1:1',
  });
  cleanup.push(() => mcp.close());
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (gate.handleRequest(req, res)) return;
    mcp.handle(req, res).catch(() => {
      if (!res.writableEnded) res.end();
    });
  });
  await listenOnSocket(server, socket);
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { socket, seen };
}

describe('the front door in front of a real editor /mcp', () => {
  it('reaches the editor through its gate with the secret and the person', async () => {
    const editor = await editorOnSocket();
    let decision: OpenDecision = { open: true, admin: false };
    const door = createDoorMcp({
      externalUrl: new URL('http://127.0.0.1'),
      table: {
        list: () => [wiki],
        byAddress: (owner, name) =>
          owner === 'team' && name === 'a' ? { wiki, current: true } : undefined,
      },
      access: { decide: async () => decision },
      processes: {
        ensure: async () => editor.socket,
        touch: () => {},
        secretOf: () => internalSecret(),
      },
      log: silentLog,
    });
    cleanup.push(() => door.close());
    const http = createServer((req, res) => {
      door.handle(req, res, alice).catch(() => {
        if (!res.writableEnded) res.end();
      });
    });
    const port = await listen(http);
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          http.closeAllConnections();
          http.close(() => resolve());
        }),
    );
    const client = new Client({ name: 'Claude', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
    cleanup.push(() => client.close());

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names[0]).toBe('list_wikis');
    expect(names).toContain('search');
    expect(names).toContain('write');
    for (const tool of tools.tools.slice(1)) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).toContain('wiki');
      expect(tool.inputSchema.required ?? []).not.toContain('wiki');
    }
    expect(editor.seen.filter((line) => line === 'POST /mcp').length).toBeGreaterThan(0);

    const result = await client.callTool({ name: 'workspace', arguments: { wiki: 'team/a' } });
    expect(result.content).toBeDefined();
    expect(editor.seen.some((line) => line.startsWith('GET '))).toBe(false);

    decision = { open: false, why: 'no-access' };
    const refused = await client.callTool({ name: 'workspace', arguments: { wiki: 'team/a' } });
    expect(refused.isError).toBe(true);
  });

  it('is refused by the editor without the internal secret', async () => {
    const editor = await editorOnSocket();
    const door = createDoorMcp({
      externalUrl: new URL('http://127.0.0.1'),
      table: { list: () => [wiki], byAddress: () => ({ wiki, current: true }) },
      access: { decide: async () => ({ open: true, admin: false }) },
      processes: { ensure: async () => editor.socket, touch: () => {}, secretOf: () => 'wrong' },
      log: silentLog,
    });
    cleanup.push(() => door.close());
    const http = createServer((req, res) => {
      door.handle(req, res, alice).catch(() => {
        if (!res.writableEnded) res.end();
      });
    });
    const port = await listen(http);
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          http.closeAllConnections();
          http.close(() => resolve());
        }),
    );
    const client = new Client({ name: 'Claude', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
    cleanup.push(() => client.close());
    await expect(
      client.callTool({ name: 'workspace', arguments: { wiki: 'team/a' } }),
    ).rejects.toThrow();
  });
});
