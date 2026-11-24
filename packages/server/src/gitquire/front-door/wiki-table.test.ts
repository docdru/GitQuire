import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openWikiTable, wikiDir, wikiKey, wikiPrefix } from './wiki-table.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tableFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-table-'));
  dirs.push(dir);
  return join(dir, 'server', 'wikis.json');
}

const repo = { host: 'github' as const, id: 41, owner: 'team', ownerId: 7, name: 'wiki' };

describe('wiki table', () => {
  it('keys folders by host and repo id (R10, R16)', () => {
    expect(wikiKey(repo)).toBe('github-41');
    expect(wikiDir('/data', { key: 'github-41' })).toBe('/data/wikis/github-41');
    expect(wikiPrefix(repo)).toBe('/w/github/team/wiki');
  });

  it('stores records and reads them back after a restart, file mode 0600', () => {
    const file = tableFile();
    const table = openWikiTable(file);
    table.add(repo, 'alice', Date.UTC(2026, 10, 21));
    table.pinOwner('team', 7);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = openWikiTable(file);
    expect(again.byKey('github-41')).toMatchObject({
      owner: 'team',
      state: 'on',
      addedBy: 'alice',
    });
    expect(again.ownerIds()).toEqual({ team: 7 });
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('looks addresses up case-insensitively, and finds former names for redirects after a rename', () => {
    const table = openWikiTable(tableFile());
    table.add(repo, 'alice', 0);
    expect(table.byAddress('github', 'TEAM', 'Wiki')).toMatchObject({ current: true });
    table.rename('github-41', { owner: 'team', name: 'handbook' });
    expect(table.byAddress('github', 'team', 'wiki')).toMatchObject({
      current: false,
      wiki: { name: 'handbook' },
    });
    expect(table.byAddress('github', 'team', 'handbook')).toMatchObject({ current: true });
    table.rename('github-41', { owner: 'team', name: 'wiki' });
    expect(table.byKey('github-41')?.formerNames).toEqual([{ owner: 'team', name: 'handbook' }]);
  });

  it('prefers a wiki that has the name now over one that had it before', () => {
    const table = openWikiTable(tableFile());
    table.add(repo, 'alice', 0);
    table.rename('github-41', { owner: 'team', name: 'old' });
    table.add({ ...repo, id: 42, name: 'wiki' }, 'bob', 0);
    expect(table.byAddress('github', 'team', 'wiki')).toMatchObject({
      current: true,
      wiki: { id: 42 },
    });
  });

  it('disconnects and reconnects, and never removes a record (R11)', () => {
    const table = openWikiTable(tableFile());
    table.add(repo, 'alice', 0);
    table.disconnect('github-41', 'removed');
    expect(table.byKey('github-41')).toMatchObject({ state: 'disconnected', reason: 'removed' });
    table.connect('github-41');
    expect(table.byKey('github-41')?.reason).toBeUndefined();
    expect(table.list()).toHaveLength(1);
    expect(table.add(repo, 'bob', 0).addedBy).toBe('alice');
  });

  it('removes a record, freeing its name and former names', () => {
    const file = tableFile();
    const table = openWikiTable(file);
    table.add(repo, 'alice', 0);
    table.rename('github-41', { owner: 'team', name: 'new' });
    expect(table.remove('github-41')?.key).toBe('github-41');
    expect(table.byAddress('github', 'team', 'new')).toBeUndefined();
    expect(table.byAddress('github', 'team', 'wiki')).toBeUndefined();
    expect(table.remove('github-41')).toBeUndefined();
    expect(openWikiTable(file).byKey('github-41')).toBeUndefined();
  });
});
