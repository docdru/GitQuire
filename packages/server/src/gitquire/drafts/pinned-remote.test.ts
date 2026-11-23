import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGitSync } from '../repo-bootstrap.ts';
import { withGitConfig } from '../repo-pin.ts';
import type { DraftRemote } from './remote.ts';
import { pinnedRemote } from './setup.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (args: string[], dir: string, env: Record<string, string> = {}) =>
  runGitSync(['-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args], dir, env);

function bareWith(root: string, path: string, file: string): string {
  const bare = join(root, path);
  mkdirSync(bare, { recursive: true });
  git(['init', '--quiet', '--bare', '--initial-branch=main'], bare);
  const work = mkdtempSync(join(root, 'work-'));
  git(['init', '--quiet', '--initial-branch=main'], work);
  writeFileSync(join(work, file), file);
  git(['add', file], work);
  git(['commit', '--quiet', '-m', file], work);
  git(['push', '--quiet', bare, 'main'], work);
  return bare;
}

describe('draft Git outside the sync engine', () => {
  it('waits for the pin before every call to the host', async () => {
    const order: string[] = [];
    const call =
      (name: string) =>
      async (..._args: unknown[]) => {
        order.push(name);
        return undefined as never;
      };
    const remote: DraftRemote = {
      kind: 'forgejo',
      headSha: call('headSha'),
      createBranch: call('createBranch'),
      deleteBranch: call('deleteBranch'),
      openReview: call('openReview'),
      publish: call('publish'),
      close: call('close'),
      closedElsewhere: call('closedElsewhere'),
      pullUrl: () => 'url',
    };
    const pinned = pinnedRemote(remote, async () => {
      order.push('pin');
    });
    await pinned.headSha('b');
    await pinned.publish({} as never, 't', { name: 'n', email: 'e' });
    await pinned.close({} as never);
    expect(order).toEqual(['pin', 'headSha', 'pin', 'publish', 'pin', 'close']);
    expect(pinned.pullUrl({} as never)).toBe('url');
  });

  it('fetches from the renamed repository, not from a new one under the old name', () => {
    const root = mkdtempSync(join(tmpdir(), 'gq-pin-'));
    roots.push(root);
    const impostor = bareWith(root, 'team/old.git', 'impostor.md');
    const real = bareWith(root, 'team/new.git', 'real.md');
    const clone = join(root, 'clone');
    git(['clone', '--quiet', impostor, clone], root);
    const origin = `file://${impostor}`;
    git(['remote', 'set-url', 'origin', origin], clone);

    const pinned = withGitConfig({}, [`url.file://${real}.insteadOf=${origin}`]);
    git(['fetch', '--quiet', 'origin', '+main:refs/remotes/origin/main'], clone, pinned);
    expect(git(['ls-tree', '--name-only', 'origin/main'], clone).trim()).toBe('real.md');

    const closed = withGitConfig({}, [
      `url.gitquire-unconfirmed://repository-7/.insteadOf=${origin}`,
    ]);
    expect(() => git(['fetch', '--quiet', 'origin'], clone, closed)).toThrow();
  });
});
