import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import { connectMcpTestClient } from './mcp/client.test-helper.ts';

let root: string;
let server: BootedServer;
let client: Client;
const templatePath = () => join(root, 'templates', '.gitquire', 'templates', 'existing.md');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-admission-cause-'));
  for (const [path, content] of [
    [templatePath(), '---\ntitle: Existing\n---\nExisting target.\n'],
  ]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  server = await bootCompositionRig(root);
  await server.ready;
  client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

test('real template edit admission leaves supplied replace open as the control source', async () => {
  const path = templatePath();
  const original = readFileSync(path);
  const result = await client.callTool({
    name: 'edit',
    arguments: {
      template: { path: 'templates/existing', find: 'target', replace: 'x😀\u0000private-tail' },
    },
  });
  expect(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  expect.soft(text).toContain('U+0000');
  expect.soft(text).toMatch(/UTF-?16/i);
  expect.soft(text).toMatch(/full[^.]*resubmit|resubmit[^.]*full/i);
  expect
    .soft(text)
    .toMatch(
      /supplied[^.]*replace|replace[^.]*supplied|replacement[^.]*submitted|submitted[^.]*replacement/i,
    );
  expect.soft(text).not.toContain('private-tail');
  expect.soft(readFileSync(path)).toEqual(original);
});

test('real ordinary Markdown refusal keeps actionable advice for a submitted document', async () => {
  const result = await client.callTool({
    name: 'write',
    arguments: { document: { path: 'ordinary', content: 'x😀\u0000private-tail' } },
  });
  expect(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  expect(text).toContain('U+0000');
  expect(text).toMatch(/TAB[^.]*LF[^.]*CR/i);
  expect(text).toMatch(/Remove[^.]*replace[^.]*printable escape/i);
  expect(text).not.toContain('private-tail');
  expect(existsSync(join(root, 'ordinary.md'))).toBe(false);
});
