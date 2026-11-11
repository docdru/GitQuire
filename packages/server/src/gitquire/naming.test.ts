import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nameRequestedPath, titleSeedFor } from './naming.ts';

const dirs: string[] = [];

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitquire-naming-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('nameRequestedPath', () => {
  it('names new segments and keeps existing folders', () => {
    const dir = project();
    mkdirSync(join(dir, 'Team Notes'));
    expect(nameRequestedPath(dir, 'Team Notes/Weekly Sync/Kick Off.md', true, {})).toBe(
      'Team Notes/weekly-sync/kick-off.md',
    );
    expect(nameRequestedPath(dir, 'New Folder', false, {})).toBe('new-folder');
  });

  it('does nothing when the rule is off', () => {
    const dir = project();
    expect(nameRequestedPath(dir, 'Kick Off.md', true, { GITQUIRE_NAMING: 'off' })).toBe(
      'Kick Off.md',
    );
  });

  it('seeds the original name as a title', () => {
    expect(titleSeedFor('Kick Off.md', 'kick-off.md')).toBe('# Kick Off\n');
  });
});
