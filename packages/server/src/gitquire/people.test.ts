import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { allowedLoginsFrom, COLLABORATOR_CACHE_MS, createPeopleDirectory } from './people.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gq-people-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('allowedLoginsFrom', () => {
  test('keeps valid GitHub usernames', () => {
    expect(allowedLoginsFrom(' alice, bob-b ,, -bad, x y')).toEqual(['alice', 'bob-b']);
    expect(allowedLoginsFrom(undefined)).toEqual([]);
  });
});

describe('createPeopleDirectory', () => {
  test('merges signed-in people, collaborators and allowed users without duplicates', async () => {
    const stateFile = join(dir, 'people.json');
    const directory = createPeopleDirectory({
      stateFile,
      allowedLogins: ['Carol', 'alice'],
      collaborators: async () => [
        { id: 1, login: 'alice', avatarUrl: 'https://a/1' },
        { id: 2, login: 'bob', avatarUrl: 'https://a/2' },
      ],
    });
    directory.remember({ id: 1, login: 'alice', name: 'Alice Archer', avatarUrl: 'https://a/1' });
    expect(await directory.list()).toEqual([
      { login: 'alice', name: 'Alice Archer', avatarUrl: 'https://a/1' },
      { login: 'bob', avatarUrl: 'https://a/2' },
      { login: 'Carol' },
    ]);

    const reopened = createPeopleDirectory({ stateFile });
    expect(await reopened.list()).toEqual([
      { login: 'alice', name: 'Alice Archer', avatarUrl: 'https://a/1' },
    ]);
  });

  test('caches collaborators and survives GitHub errors', async () => {
    let clock = 0;
    let calls = 0;
    let fail = false;
    const errors: unknown[] = [];
    const directory = createPeopleDirectory({
      stateFile: join(dir, 'people.json'),
      now: () => clock,
      onError: (err) => errors.push(err),
      collaborators: async () => {
        calls += 1;
        if (fail) throw new Error('HTTP 403');
        return [{ id: 2, login: 'bob', avatarUrl: '' }];
      },
    });
    expect((await directory.list()).map((p) => p.login)).toEqual(['bob']);
    await directory.list();
    expect(calls).toBe(1);

    clock += COLLABORATOR_CACHE_MS + 1;
    fail = true;
    expect((await directory.list()).map((p) => p.login)).toEqual(['bob']);
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
  });
});
