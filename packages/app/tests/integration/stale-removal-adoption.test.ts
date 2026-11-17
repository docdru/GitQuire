import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { runTeardownPhases } from '../stress/_helpers/teardown-fs.ts';
import { ORIGINAL, startDeletionScenario } from './stale-delete-recreation.test-helper.ts';

const cleanups: Array<() => Promise<void>> = [];
const registerCleanup = (cleanup: () => Promise<void>) => cleanups.push(cleanup);

afterEach(async () => {
  await runTeardownPhases(...cleanups.splice(0).reverse());
});

test('an older write completion cannot adopt the unmodified resident of a recreated page', async () => {
  const scenario = await startDeletionScenario('classified', registerCleanup);
  const client = await scenario.open();
  expect(client.ytext.toString()).toBe(ORIGINAL);
  const oldResident = scenario.server.instance.hocuspocus.documents.get(scenario.docName);
  expect(oldResident).toBeDefined();
  const oldWritten = '# Accepted before recreation\n';
  const replacement = '# Replacement without resident adoption\n';
  const templateDir = join(scenario.server.contentDir, '.gitquire', 'templates');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, 'replacement.md'), replacement, { flag: 'wx' });
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const durability = scenario.server.instance.durabilityState;
  const originalOutcome = durability.awaitDeferredStoreOutcome.bind(durability);
  let captured = false;
  const spy = vi.spyOn(durability, 'awaitDeferredStoreOutcome').mockImplementation(async (name) => {
    const result = await originalOutcome(name);
    if (name === scenario.docName && !captured) {
      captured = true;
      reached.resolve();
      await release.promise;
    }
    return result;
  });
  const pendingWrite = fetch(`${scenario.server.baseUrl}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName: scenario.docName,
      markdown: oldWritten,
      position: 'replace',
      agentId: 'obsolete-writer',
    }),
  });
  registerCleanup(async () => {
    release.resolve();
    await pendingWrite;
    spy.mockRestore();
  });
  await reached.promise;
  const filePath = join(scenario.server.contentDir, `${scenario.docName}.md`);
  expect(readFileSync(filePath, 'utf8')).toBe(oldWritten);
  expect(oldResident?.getText('source').toString()).toBe(oldWritten);
  scenario.deleteExternally();
  await scenario.waitUntilHeld();
  const created = await fetch(`${scenario.server.baseUrl}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${scenario.docName}.md`, template: 'replacement' }),
  });
  expect(created.status).toBe(200);
  expect(readFileSync(filePath, 'utf8')).toBe(replacement);
  expect(oldResident?.getText('source').toString()).toBe(oldWritten);
  release.resolve();
  expect((await pendingWrite).status).toBe(200);
  await scenario.finishDeletion();
  expect(scenario.server.instance.hocuspocus.documents.get(scenario.docName)).not.toBe(oldResident);
  expect(readFileSync(filePath, 'utf8')).toBe(replacement);
  expect((await scenario.readDocument()).content).toBe(replacement);
});
