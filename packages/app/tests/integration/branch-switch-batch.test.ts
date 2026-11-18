import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectGit } from '@gitquire/server';
import { afterEach, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { getMetrics } from '../../../server/src/metrics';
import { checkoutBranch, createTestClient, createTestServer, pollUntil } from './test-harness';

const cleanups: Array<() => Promise<void> | void> = [];
const _CAN_REVOKE_READ = process.getuid?.() !== 0;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.local',
    },
    stdio: 'ignore',
  });
}

async function openNotesTypedOnMain() {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-branch-switch-batch-')));
  cleanups.push(() => rmSync(contentDir, { recursive: true, force: true }));
  git(contentDir, 'init --initial-branch=main');
  await ensureProjectGit(contentDir);
  configureTestGitRepository(contentDir);
  const notes = join(contentDir, 'notes.md');
  writeFileSync(notes, '# Notes\n\nShared line on main.\n\nTail.\n');
  git(contentDir, 'add notes.md');
  git(contentDir, 'commit -m main');
  git(contentDir, 'checkout -b feature');
  writeFileSync(notes, '# Notes\n\nShared line on feature.\n\nTail.\n');
  git(contentDir, 'commit -am feature');
  git(contentDir, 'checkout main');

  const server = await createTestServer({
    contentDir,
    keepContentDir: true,
    gitEnabled: true,
    debounce: 300_000,
    maxDebounce: 600_000,
  });
  cleanups.push(() => server.cleanup());
  const client = await createTestClient(server.port, 'notes', { skipInvariantWatcher: true });
  cleanups.push(() => client.cleanup());
  await pollUntil(() => client.ytext.toString().includes('on main.'), 10_000, 25, 'the load');
  const liveText = () =>
    server.instance.hocuspocus.documents.get('notes')?.getText('source').toString() ?? '';

  client.doc.transact(() => {
    const at = client.ytext.toString().indexOf('Shared line on main.');
    client.ytext.delete(at, 'Shared line on main.'.length);
    client.ytext.insert(at, 'Shared line on main, typed here.');
  });
  await pollUntil(() => liveText().includes('typed here'), 10_000, 25, 'the typing');

  const switchTo = async (branch: 'feature' | 'main'): Promise<void> => {
    await checkoutBranch(server, branch);
    expect(readFileSync(notes, 'utf-8')).toContain(`on ${branch}.`);
    await pollUntil(
      () =>
        !server.instance.durabilityState.isBatchInProgress() &&
        liveText().includes(`on ${branch}.`),
      15_000,
      25,
      `the switch to ${branch} to end and take in its file`,
    );
  };

  return {
    contentDir,
    liveText,
    lifecycleStatus: () =>
      server.instance.hocuspocus.documents.get('notes')?.getMap('lifecycle').get('status'),
    switchToFeature: () => switchTo('feature'),
    switchBackToMain: () => switchTo('main'),
  };
}

describe('a git branch switch is taken in like any other outside change', () => {
  test('unsaved typing in the block the other branch changed keeps both versions', async () => {
    const rig = await openNotesTypedOnMain();
    const shortfallsBefore = getMetrics().branchSwitchRecheckShortfalls;

    await rig.switchToFeature();

    expect(rig.liveText()).toContain('Shared line on main, typed here.');
    expect(rig.liveText()).toContain('Shared line on feature.');
    expect(rig.liveText()).not.toContain('<<<<<<<');
    expect(rig.lifecycleStatus()).toBeUndefined();
    expect(getMetrics().branchSwitchRecheckShortfalls - shortfallsBefore).toBe(0);
  }, 60_000);
});
