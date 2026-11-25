import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forgejoNames, gitHubNames } from '../host/names.ts';
import type { AccountAddress, DoorHost } from '../host/types.ts';
import { readMailRecord } from '../people/mail.ts';
import { createPeopleStore } from '../people/store.ts';
import { accountAddressReader } from './account-addresses.ts';
import type { DoorHostEntry } from './door-hosts.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gq-account-'));
  dirs.push(dir);
  const store = createPeopleStore(join(dir, 'people'));
  const lines: string[] = [];
  const log = {
    info: (fields: unknown, message: string) => lines.push(`${message} ${JSON.stringify(fields)}`),
    warn: (fields: unknown, message: string) => lines.push(`${message} ${JSON.stringify(fields)}`),
    error: () => {},
  };
  return { dir, store, lines, log };
}

function entry(key: string, answer: () => Promise<AccountAddress>): DoorHostEntry {
  const names = key === 'github' ? gitHubNames() : forgejoNames('{login}@noreply.git.example.org');
  return {
    key,
    names,
    host: { accountAddress: answer } as unknown as DoorHost,
  } as unknown as DoorHostEntry;
}

const anna = { id: 5, login: 'anna', name: 'Anna', avatarUrl: '' };

describe('reading the account address at sign-in', () => {
  it('keeps it in that account’s own folder and logs only the login (P1, P5)', async () => {
    const { dir, store, lines, log } = setup();
    const read = accountAddressReader({ store, log });
    await read(
      entry('github', async () => ({ state: 'found', address: 'anna@example.org' })),
      anna,
      't',
    );
    await read(
      entry('forgejo', async () => ({ state: 'found', address: 'anna@example.org' })),
      anna,
      't',
    );
    expect(store.people()).toEqual(['forgejo-5', 'github-5']);
    expect(readMailRecord(store, 'github-5').account?.address).toBe('anna@example.org');
    expect(readMailRecord(store, 'github-5').use).toBeUndefined();
    expect(lines.join('\n')).not.toContain('anna@example.org');
    expect(lines.join('\n')).toContain('"login":"anna"');
    expect(readFileSync(join(dir, 'people', 'github-5', 'mail.json'), 'utf8')).toContain(
      'anna@example.org',
    );
  });

  it('skips the host’s no-reply address', async () => {
    const { store, log } = setup();
    await accountAddressReader({ store, log })(
      entry('forgejo', async () => ({ state: 'found', address: 'anna@noreply.git.example.org' })),
      anna,
      't',
    );
    expect(readMailRecord(store, 'forgejo-5').account).toBeUndefined();
    expect(readMailRecord(store, 'forgejo-5').accountProblem).toBe('none');
  });

  it('does not hold up the sign-in when the host is slow', async () => {
    const { store, log } = setup();
    const started = Date.now();
    await accountAddressReader({ store, log, deadlineMs: 50 })(
      entry('github', () => new Promise(() => {})),
      anna,
      't',
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(readMailRecord(store, 'github-5').accountProblem).toBe('unreachable');
  });

  it('treats a failing call as an outage and a host without the call as a refusal', async () => {
    const { store, log } = setup();
    const read = accountAddressReader({ store, log });
    await read(
      entry('github', () => Promise.reject(new Error('boom'))),
      anna,
      't',
    );
    expect(readMailRecord(store, 'github-5').accountProblem).toBe('unreachable');
    const without = {
      ...entry('forgejo', async () => ({ state: 'none' })),
      host: {},
    } as DoorHostEntry;
    await read(without, anna, 't');
    expect(readMailRecord(store, 'forgejo-5').accountProblem).toBe('refused');
  });
});
