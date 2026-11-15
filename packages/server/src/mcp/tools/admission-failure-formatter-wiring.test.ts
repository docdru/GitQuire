import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ConfigSchema } from '../../config/schema.ts';
import { installJsonSchemaDialect } from '../json-schema-dialect.ts';
import { register as registerEdit } from './edit.ts';
import { register as registerWrite } from './write.ts';

const failures = [
  {
    status: 409,
    type: 'urn:ok:error:doc-in-conflict',
    title: 'Conflict',
    detail: 'Resolve the conflict first.',
  },
  {
    status: 503,
    type: 'urn:ok:error:too-many-agent-sessions',
    title: 'Session limit',
    detail: 'Retry after a session closes.',
  },
  {
    status: 404,
    type: 'urn:ok:error:not-found',
    title: 'Missing target',
    detail: 'The target was removed.',
  },
] as const;
const cases = [
  {
    label: 'template write',
    tool: 'write',
    args: {
      template: {
        path: 'templates/existing',
        content: 'Safe.',
        frontmatter: { title: 'Existing' },
      },
    },
  },
  {
    label: 'template body edit',
    tool: 'edit',
    args: { template: { path: 'templates/existing', find: 'target', replace: 'replacement' } },
  },
  {
    label: 'template frontmatter edit',
    tool: 'edit',
    args: { template: { path: 'templates/existing', frontmatter: { description: 'Updated' } } },
  },
] as const;
let root: string;
let listener: Server;
let mcp: McpServer;
let client: Client;
let failure: { status: number; type: string; title: string; detail: string } = failures[0];
let putCount = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-error-formatter-wiring-'));
  const templates = join(root, 'templates', '.ok', 'templates');
  mkdirSync(templates, { recursive: true });
  writeFileSync(join(templates, 'existing.md'), '---\ntitle: Existing\n---\nExisting target.\n');
  listener = createServer((req, res) => {
    req.resume();
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    putCount++;
    res.writeHead(failure.status, { 'Content-Type': 'application/problem+json' });
    res.end(JSON.stringify(failure));
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP listener has no port');
  mcp = new McpServer({ name: 'formatter-wiring', version: '1' });
  const deps = {
    config: ConfigSchema.parse({ content: { dir: '.' } }),
    resolveCwd: async () => root,
    serverUrl: `http://127.0.0.1:${address.port}`,
  };
  registerWrite(mcp, deps);
  registerEdit(mcp, deps);
  installJsonSchemaDialect(mcp);
  client = new Client({ name: 'formatter-wiring', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);
});

afterAll(async () => {
  await client?.close();
  await mcp?.close();
  if (listener)
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  rmSync(root, { recursive: true, force: true });
});

describe.each(failures)(
  'controlled HTTP $status formatter wiring, not persistence fidelity',
  (problem) => {
    test.each(cases)(
      '$label preserves failure detail without content-offset advice',
      async ({ tool, args }) => {
        failure = problem;
        const count = putCount;
        const result = await client.callTool({ name: tool, arguments: args });
        expect(putCount).toBe(count + 1);
        expect(result.isError).toBe(true);
        const text = JSON.stringify(result.content);
        expect.soft(text).toContain(problem.title);
        expect.soft(text).toContain(problem.detail);
        expect.soft(text).not.toMatch(/(?:body|content) offset|full submitted|whole submitted/i);
      },
    );
  },
);
