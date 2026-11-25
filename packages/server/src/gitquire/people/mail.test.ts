import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountOffer,
  mailAddressOf,
  readMailRecord,
  recordAccountAddress,
  updateMailRecord,
  withAccountAddress,
  withoutAddress,
} from './mail.ts';
import { createPeopleStore } from './store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'gq-people-mail-'));
  dirs.push(dir);
  return createPeopleStore(join(dir, 'people'));
}

const at = new Date('2026-11-25T10:00:00Z');

describe('the account address in the per-person store', () => {
  it('is only recorded at sign-in: the switch stays off (P7)', () => {
    const people = store();
    const record = recordAccountAddress(
      people,
      'forgejo-3',
      'anna',
      { state: 'found', address: 'anna@example.org' },
      at,
    );
    expect(record.use).toBeUndefined();
    expect(record.since).toBeUndefined();
    expect(mailAddressOf(record, undefined)).toBeUndefined();
    expect(accountOffer(record, undefined)).toEqual({ offered: true, address: 'anna@example.org' });
  });

  it('turns a moved address into the account address at the first sign-in that finds the same one', () => {
    const people = store();
    updateMailRecord(people, 'forgejo-3', () => ({
      login: 'anna',
      use: 'other',
      other: { address: 'Anna@Example.org', confirmedAt: '2026-10-01T00:00:00.000Z', moved: true },
      since: '2026-10-01T00:00:00.000Z',
    }));
    updateMailRecord(people, 'forgejo-4', () => ({
      login: 'bert',
      use: 'other',
      other: { address: 'bert@example.org', confirmedAt: '2026-10-01T00:00:00.000Z' },
      since: '2026-10-01T00:00:00.000Z',
    }));
    const chosen = recordAccountAddress(
      people,
      'forgejo-4',
      'bert',
      { state: 'found', address: 'bert@example.org' },
      at,
    );
    expect(chosen.use).toBe('other');
    const first = recordAccountAddress(
      people,
      'forgejo-3',
      'anna',
      { state: 'found', address: 'anna@example.org' },
      at,
    );
    expect(first.use).toBe('account');
    updateMailRecord(people, 'forgejo-3', (record) => ({ ...record, use: 'other' }));
    const later = recordAccountAddress(
      people,
      'forgejo-3',
      'anna',
      { state: 'found', address: 'anna@example.org' },
      at,
    );
    expect(later.use).toBe('other');
  });

  it('follows the account: a changed address replaces the old one at the next sign-in (P11)', () => {
    const people = store();
    recordAccountAddress(
      people,
      'github-3',
      'anna',
      { state: 'found', address: 'old@example.org' },
      at,
    );
    updateMailRecord(people, 'github-3', (record) => ({
      ...record,
      use: 'account',
      since: at.toISOString(),
    }));
    expect(mailAddressOf(readMailRecord(people, 'github-3'), undefined)).toBe('old@example.org');
    recordAccountAddress(
      people,
      'github-3',
      'anna',
      { state: 'found', address: 'new@example.org' },
      at,
    );
    expect(mailAddressOf(readMailRecord(people, 'github-3'), undefined)).toBe('new@example.org');
  });

  it('stops mail when the address disappears from the account, and says why (P11)', () => {
    const people = store();
    recordAccountAddress(
      people,
      'github-3',
      'anna',
      { state: 'found', address: 'old@example.org' },
      at,
    );
    updateMailRecord(people, 'github-3', (record) => ({ ...record, use: 'account' }));
    recordAccountAddress(people, 'github-3', 'anna', { state: 'none' }, at);
    const record = readMailRecord(people, 'github-3');
    expect(mailAddressOf(record, undefined)).toBeUndefined();
    expect(accountOffer(record, undefined)).toEqual({ offered: false, why: 'none' });
    recordAccountAddress(people, 'github-3', 'anna', { state: 'refused' }, at);
    expect(accountOffer(readMailRecord(people, 'github-3'), undefined)).toEqual({
      offered: false,
      why: 'refused',
    });
  });

  it('keeps the last verified address when the host could not be asked', () => {
    const record = withAccountAddress(
      { account: { address: 'anna@example.org', readAt: 'earlier' }, use: 'account' },
      'anna',
      { state: 'unreachable' },
      at,
    );
    expect(record.account).toEqual({ address: 'anna@example.org', readAt: 'earlier' });
    expect(mailAddressOf(record, undefined)).toBe('anna@example.org');
  });

  it('offers and mails only within GITQUIRE_MAIL_DOMAINS', () => {
    const record = withAccountAddress(
      { use: 'account' },
      'anna',
      {
        state: 'found',
        address: 'anna@private.example',
      },
      at,
    );
    const config = { allowedDomains: ['example.org'] };
    expect(accountOffer(record, config)).toEqual({ offered: false, why: 'domain' });
    expect(mailAddressOf(record, config)).toBeUndefined();
    const other = {
      use: 'other' as const,
      other: { address: 'a@elsewhere.example', confirmedAt: 'x' },
    };
    expect(mailAddressOf(other, config)).toBeUndefined();
    expect(mailAddressOf(other, undefined)).toBe('a@elsewhere.example');
  });

  it('stops using an address it could not check with the host for 30 days', () => {
    const record = withAccountAddress(
      { account: { address: 'anna@example.org', readAt: '2026-10-01T00:00:00Z' }, use: 'account' },
      'anna',
      { state: 'unreachable' },
      at,
    );
    expect(mailAddressOf(record, undefined, Date.parse('2026-10-20T00:00:00Z'))).toBe(
      'anna@example.org',
    );
    expect(mailAddressOf(record, undefined, Date.parse('2026-11-01T00:00:01Z'))).toBeUndefined();
    expect(accountOffer(record, undefined, Date.parse('2026-11-01T00:00:01Z'))).toEqual({
      offered: false,
      why: 'unreachable',
    });
  });
});

describe('keeping the address out of log lines (P1)', () => {
  it('removes the address in any case, every time it appears', () => {
    expect(
      withoutAddress(
        '550 <Anna@Example.org> unknown; retry anna@example.ORG later',
        'anna@example.org',
      ),
    ).toBe('550 <<address>> unknown; retry <address> later');
    expect(withoutAddress('no address here', 'anna@example.org')).toBe('no address here');
  });
});
