import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepoTokenStore, repoTokensFile } from './repo-tokens.ts';

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
  });
});
