import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDataFolderHost, dataFolderHostFile } from './data-folder.ts';
import { HostConfigError } from './names.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitquire-host-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function state(name: string): string {
  const folder = join(dir, '.gitquire', 'local', 'gitquire');
  mkdirSync(folder, { recursive: true });
  return join(folder, name);
}

describe('data folder host', () => {
  it('writes nothing for GitHub, as before', () => {
    writeFileSync(state('people.json'), '{}');
    checkDataFolderHost(dir, 'github');
    expect(existsSync(dataFolderHostFile(dir))).toBe(false);
  });

  it('records another host on a fresh folder and accepts it again', () => {
    checkDataFolderHost(dir, 'forgejo');
    expect(JSON.parse(readFileSync(dataFolderHostFile(dir), 'utf8'))).toEqual({ host: 'forgejo' });
    expect(() => checkDataFolderHost(dir, 'forgejo')).not.toThrow();
  });

  it('refuses a folder that GitHub people already used for another host', () => {
    writeFileSync(state('mentions.json'), '{}');
    expect(() => checkDataFolderHost(dir, 'forgejo')).toThrow(HostConfigError);
    expect(() => checkDataFolderHost(dir, 'forgejo')).toThrow('mentions.json');
    expect(existsSync(dataFolderHostFile(dir))).toBe(false);
  });

  it('refuses GitHub on a folder recorded for another host', () => {
    writeFileSync(state('host.json'), JSON.stringify({ host: 'forgejo' }));
    expect(() => checkDataFolderHost(dir, 'github')).toThrow('forgejo');
  });

  it('refuses an unreadable record', () => {
    writeFileSync(state('host.json'), 'not json');
    expect(() => checkDataFolderHost(dir, 'github')).toThrow('an unknown host');
  });
});
