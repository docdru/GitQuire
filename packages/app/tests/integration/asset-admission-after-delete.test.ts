import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PagesSuccessSchema } from '@gitquire/core';
import { afterEach, expect, test } from 'vitest';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import { createTestServer, type TestServer } from './test-harness.ts';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

const docName = 'child/note';
const assetPath = 'child/image.png';

async function startScenario() {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'gq-asset-admission-')));
  const filePath = join(contentDir, `${docName}.md`);
  mkdirSync(join(contentDir, 'child'));
  writeFileSync(filePath, '# Only Markdown\n');
  writeFileSync(join(contentDir, assetPath), new Uint8Array([1, 2, 3]));
  let server: TestServer | undefined;
  cleanups.push(
    () => rmSync(contentDir, { recursive: true, force: true }),
    async () => {
      await server?.cleanup();
    },
  );
  server = await createTestServer({ contentDir });
  const running = server;
  const post = (route: string, body: unknown) =>
    fetch(`${running.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    filePath,
    server: running,
    async snapshot() {
      const response = await fetch(`${running.baseUrl}/api/pages`);
      expect(response.status).toBe(200);
      const pages = PagesSuccessSchema.parse(await response.json());
      expect(existsSync(join(contentDir, assetPath))).toBe(true);
      return {
        disk: existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
        indexed: pages.pages.some((page) => page.docName === docName),
        assetAdmitted: !running.instance.contentFilter.isExcluded(assetPath),
      };
    },
    async deleteThroughApi() {
      expect((await post('/api/delete-path', { kind: 'file', path: docName })).status).toBe(200);
    },
    async createThroughApi() {
      expect((await post('/api/create-page', { path: `${docName}.md` })).status).toBe(200);
    },
  };
}

test('a re-check after the last Markdown in a folder is deleted removes sibling asset admission', async () => {
  const scenario = await startScenario();
  expect((await scenario.snapshot()).assetAdmitted).toBe(true);

  unlinkSync(scenario.filePath);
  await scenario.server.instance.recheckDisk();
  expect(await scenario.snapshot()).toEqual({ disk: null, indexed: false, assetAdmitted: false });
});

test('an API deletion, recreation and final deletion leave sibling asset admission balanced', async () => {
  const scenario = await startScenario();
  expect((await scenario.snapshot()).assetAdmitted).toBe(true);

  await scenario.deleteThroughApi();
  await scenario.createThroughApi();
  expect(await scenario.snapshot()).toEqual({ disk: '', indexed: true, assetAdmitted: true });

  await scenario.deleteThroughApi();
  expect(await scenario.snapshot()).toEqual({ disk: null, indexed: false, assetAdmitted: false });
});
