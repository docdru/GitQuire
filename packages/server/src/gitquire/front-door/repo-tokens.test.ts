import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openRepoTokenFile,
  openRepoTokenStore,
  repoTokenKey,
  repoTokensFile,
} from './repo-tokens.ts';
import type { WikiRecord } from './wiki-table.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('repo token store', () => {
  it('keeps one token per wiki in a 0600 file under /data/server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gq-tokens-'));
    dirs.push(dir);
    const file = repoTokensFile(dir);
    expect(file).toBe(join(dir, 'server', 'repo-tokens.json'));
    const keyOf = (repo: { owner: string; name: string }) =>
      repo.name === 'wiki' ? 'forgejo-3' : undefined;
    const store = openRepoTokenStore(file, keyOf);
    store.set('forgejo-3', 'limited');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = openRepoTokenStore(file, keyOf);
    expect(again.tokenFor({ owner: 'team', name: 'wiki' })).toBe('limited');
    expect(again.tokenFor({ owner: 'team', name: 'other' })).toBeUndefined();
    expect(again.has('forgejo-3')).toBe(true);
    again.forget('forgejo-3');
    expect(openRepoTokenStore(file, keyOf).has('forgejo-3')).toBe(false);
  });

  it('keeps the tokens of two Forgejo hosts in one file without one overwriting the other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gq-tokens-'));
    dirs.push(dir);
    const file = repoTokensFile(dir);
    const shared = openRepoTokenFile(file);
    const first = shared.scoped((repo) => (repo.name === 'a' ? 'forgejo-2' : undefined));
    const lab = shared.scoped((repo) => (repo.name === 'b' ? 'lab-5' : undefined));
    lab.set('lab-5', 'lab-token');
    first.set('forgejo-2', 'first-token');
    const again = openRepoTokenFile(file);
    expect(again.scoped(() => 'lab-5').tokenFor({ owner: 'team', name: 'b' })).toBe('lab-token');
    expect(again.scoped(() => 'forgejo-2').tokenFor({ owner: 'team', name: 'a' })).toBe(
      'first-token',
    );
    expect(first.tokenFor({ owner: 'team', name: 'b' })).toBeUndefined();
  });

  it('finds a wiki’s token by its repository id, not by a name another repository may now have', () => {
    const old: WikiRecord = {
      host: 'forgejo',
      id: 3,
      owner: 'team',
      ownerId: 1,
      name: 'old',
      key: 'forgejo-3',
      state: 'on',
      formerNames: [],
      addedBy: 'alice',
      addedAt: '',
    };
    const impostor: WikiRecord = { ...old, id: 9, key: 'forgejo-9' };
    const wikis = [old, impostor];
    const keyOf = repoTokenKey(
      {
        byId: (host, id) => wikis.find((wiki) => wiki.host === host && wiki.id === id),
        byAddress: (_host, owner, name) => {
          const wiki = wikis.find((w) => w.owner === owner && w.name === name);
          return wiki === undefined ? undefined : { wiki, current: true };
        },
      },
      'forgejo',
    );
    expect(keyOf(impostor)).toBe('forgejo-9');
    expect(keyOf(old)).toBe('forgejo-3');
    expect(keyOf({ owner: 'team', name: 'old' })).toBe('forgejo-3');
    expect(keyOf({ owner: 'team', name: 'old', id: 42 })).toBeUndefined();
  });
});
