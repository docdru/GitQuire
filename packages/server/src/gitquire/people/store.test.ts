import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPeopleStore, isPersonId, personId, SETTINGS_FILE } from './store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-people-'));
  dirs.push(dir);
  return join(dir, 'people');
}

const counter = (raw: unknown): { n: number } =>
  typeof raw === 'object' && raw !== null && typeof (raw as { n?: unknown }).n === 'number'
    ? { n: (raw as { n: number }).n }
    : { n: 0 };

describe('the per-person store', () => {
  it('keeps one folder per account, so the same number on two hosts never meets', () => {
    const store = createPeopleStore(root());
    store.updateJson(personId('github-', 7), 'prefs.json', counter, () => ({ n: 1 }));
    store.updateJson(personId('forgejo-', 7), 'prefs.json', counter, () => ({ n: 2 }));
    expect(store.people()).toEqual(['forgejo-7', 'github-7']);
    expect(store.readJson('github-7', 'prefs.json', counter)).toEqual({ n: 1 });
    expect(store.readJson('forgejo-7', 'prefs.json', counter)).toEqual({ n: 2 });
  });

  it('writes files only the server user can read', () => {
    const dir = root();
    const store = createPeopleStore(dir);
    store.writeText('github-7', SETTINGS_FILE, 'theme: dark\n');
    store.updateJson('github-7', 'mail.json', counter, () => ({ n: 3 }));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'github-7')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'github-7', SETTINGS_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'github-7', 'mail.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'github-7')).sort()).toEqual(['mail.json', SETTINGS_FILE]);
    expect(JSON.parse(readFileSync(join(dir, 'github-7', 'mail.json'), 'utf8'))).toEqual({ n: 3 });
  });

  it('refuses ids that could leave its folder', () => {
    const store = createPeopleStore(root());
    for (const bad of ['../x-1', 'github-0', 'github-1/..', 'GitHub-1', '7', '']) {
      expect(isPersonId(bad)).toBe(false);
      expect(() => store.readText(bad, SETTINGS_FILE)).toThrow();
    }
    expect(() => personId('github-', 0)).toThrow();
  });

  it('hands out copies, so a caller cannot change what is stored by accident', () => {
    const store = createPeopleStore(root());
    store.updateJson('github-7', 'prefs.json', counter, () => ({ n: 1 }));
    const read = store.readJson('github-7', 'prefs.json', (raw) => raw as { n: number });
    read.n = 99;
    expect(store.readJson('github-7', 'prefs.json', counter)).toEqual({ n: 1 });
  });

  it('forgets a removed file, also in what it keeps in memory', () => {
    const store = createPeopleStore(root());
    store.updateJson('github-7', 'prefs.json', counter, () => ({ n: 4 }));
    expect(store.changedAt('github-7', 'prefs.json')).toBeTypeOf('number');
    store.remove('github-7', 'prefs.json');
    expect(store.readJson('github-7', 'prefs.json', counter)).toEqual({ n: 0 });
    expect(store.changedAt('github-7', 'prefs.json')).toBeUndefined();
  });
});
