import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { createTempDirFactory } from '../../../../../test-support/temp-dir.test-helper.ts';
import { register } from './workspace.ts';

const makeTempDir = createTempDirFactory(afterAll);

afterEach(() => vi.unstubAllEnvs());

async function callWorkspace(cwd: string) {
  const server = new McpServer({ name: 'workspace-test', version: '1' });
  register(server, { resolveCwd: async () => cwd });
  const client = new Client({ name: 'workspace-test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    return await client.callTool({ name: 'workspace', arguments: {} });
  } finally {
    await client.close();
  }
}

function repoOn(branch: string): string {
  const dir = makeTempDir('gq-workspace-');
  execFileSync('git', ['init', '--quiet', '--initial-branch', branch, dir]);
  return dir;
}

test('reports the live wiki and its branch', async () => {
  vi.stubEnv('GITQUIRE_DRAFT', '');
  const result = await callWorkspace(repoOn('main'));
  expect(result.structuredContent).toMatchObject({ kind: 'live', branch: 'main', draft: null });
  expect(JSON.stringify(result.content)).toContain('live wiki (branch main)');
});

test('reports the draft a draft instance serves', async () => {
  vi.stubEnv('GITQUIRE_DRAFT', 'plan');
  vi.stubEnv('GITQUIRE_DRAFT_TITLE', 'Plan');
  vi.stubEnv('GITQUIRE_DRAFT_BASE', 'main');
  const result = await callWorkspace(repoOn('draft/plan'));
  expect(result.structuredContent).toMatchObject({
    kind: 'draft',
    branch: 'draft/plan',
    draft: { slug: 'plan', title: 'Plan', base: 'main' },
  });
  expect(JSON.stringify(result.content)).toContain('the draft \\"Plan\\" (branch draft/plan');
});
