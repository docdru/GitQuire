import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailConfig, MailMessage } from '../mail.ts';
import { createEmailService, EmailRequestError } from './email-service.ts';
import { recordAccountAddress } from './mail.ts';
import { createPeopleStore } from './store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const config: MailConfig = {
  host: 'smtp.example.org',
  port: 587,
  implicitTls: false,
  startTls: true,
  user: undefined,
  password: undefined,
  from: 'wiki@example.org',
  externalUrl: 'https://wiki.example.org',
  allowedDomains: undefined,
};

function setup(options: { mail?: 'on' | 'off'; domains?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gq-email-'));
  dirs.push(dir);
  const store = createPeopleStore(join(dir, 'people'));
  const sent: MailMessage[] = [];
  let at = Date.parse('2026-11-25T10:00:00Z');
  const switchedOn: string[] = [];
  const logs: string[] = [];
  const service = createEmailService({
    store,
    countersFile: join(dir, 'mail-recipients.json'),
    mail:
      options.mail === 'off'
        ? { kind: 'off' }
        : { kind: 'on', config: { ...config, allowedDomains: options.domains } },
    codeKey: () => 'k'.repeat(32),
    send: async (_config, message) => {
      sent.push(message);
    },
    log: {
      info: (fields, message) => logs.push(`${message} ${JSON.stringify(fields)}`),
      warn: (fields, message) => logs.push(`${message} ${JSON.stringify(fields)}`),
    },
    onSwitchedOn: (person) => switchedOn.push(person),
    now: () => at,
  });
  return {
    store,
    service,
    sent,
    switchedOn,
    logs,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const anna = { person: 'github-5', login: 'anna', hostLabel: 'GitHub' };

function codeOf(message: MailMessage | undefined): string {
  const match = /Confirmation code: ([A-Z0-9-]+)/.exec(message?.text ?? '');
  if (match?.[1] === undefined) throw new Error('no code');
  return match[1];
}

describe('mention email per account', () => {
  it('turns on for the account address with one switch, sending nothing (P7)', async () => {
    const { store, service, sent, switchedOn } = setup();
    recordAccountAddress(
      store,
      'github-5',
      'anna',
      { state: 'found', address: 'anna@example.org' },
      new Date(),
    );
    expect(service.state('github-5')).toMatchObject({
      address: null,
      use: null,
      account: { address: 'anna@example.org', why: null },
    });
    const on = await service.change(anna, { use: 'account' });
    expect(on).toMatchObject({ address: 'anna@example.org', use: 'account' });
    expect(sent).toEqual([]);
    expect(switchedOn).toEqual(['github-5']);
    expect((await service.change(anna, { use: null })).address).toBeNull();
  });

  it('refuses the switch without a verified account address (P2)', async () => {
    const { store, service } = setup();
    recordAccountAddress(store, 'github-5', 'anna', { state: 'refused' }, new Date());
    await expect(service.change(anna, { use: 'account' })).rejects.toMatchObject({
      code: 'no-account-address',
    });
    expect(service.state('github-5').account).toEqual({ address: null, why: 'refused' });
  });

  it('uses another address only after the code from the mail (P2)', async () => {
    const { service, sent, logs } = setup();
    const waiting = await service.change(anna, { address: 'anna@elsewhere.example' });
    expect(waiting).toMatchObject({ address: null, pending: 'anna@elsewhere.example' });
    expect(sent.map((m) => m.to)).toEqual(['anna@elsewhere.example']);
    expect(() => service.confirm(anna, { code: 'WRONG-CODE' })).toThrow(EmailRequestError);
    const done = service.confirm(anna, { code: codeOf(sent[0]) });
    expect(done).toMatchObject({ address: 'anna@elsewhere.example', use: 'other', pending: null });
    expect(logs.join('\n')).not.toContain('anna@elsewhere.example');
  });

  it('keeps two accounts apart, also with the same address (P5)', async () => {
    const { store, service } = setup();
    for (const person of ['github-5', 'forgejo-5']) {
      recordAccountAddress(
        store,
        person,
        'anna',
        { state: 'found', address: 'anna@example.org' },
        new Date(),
      );
    }
    await service.change(anna, { use: 'account' });
    expect(service.state('github-5').use).toBe('account');
    expect(service.state('forgejo-5').use).toBeNull();
  });

  it('holds the code limits per person and for the whole server', async () => {
    const { service, advance } = setup();
    await service.change(anna, { address: 'a1@example.org' });
    await expect(service.change(anna, { address: 'a2@example.org' })).rejects.toMatchObject({
      code: 'resend-too-soon',
    });
    for (let n = 2; n <= 5; n += 1) {
      advance(61_000);
      await service.change(anna, { address: `a${n}@example.org` });
    }
    advance(61_000);
    await expect(service.change(anna, { address: 'a6@example.org' })).rejects.toMatchObject({
      code: 'too-many-codes',
    });
    const bob = { person: 'forgejo-9', login: 'bob', hostLabel: 'Forgejo' };
    for (let n = 0; n < 3; n += 1) {
      advance(61_000);
      await service.change({ ...bob, person: `forgejo-${9 + n}` }, { address: 'same@example.org' });
    }
    await expect(
      service.change({ ...bob, person: 'forgejo-20' }, { address: 'same@example.org' }),
    ).rejects.toMatchObject({ code: 'too-many-codes' });
  });

  it('applies GITQUIRE_MAIL_DOMAINS to both kinds of address', async () => {
    const { store, service } = setup({ domains: ['example.org'] });
    recordAccountAddress(
      store,
      'github-5',
      'anna',
      { state: 'found', address: 'anna@private.example' },
      new Date(),
    );
    expect(service.state('github-5').account).toEqual({ address: null, why: 'domain' });
    await expect(service.change(anna, { address: 'anna@private.example' })).rejects.toMatchObject({
      code: 'address-not-allowed',
    });
  });

  it('says when the server cannot mail', async () => {
    const { service } = setup({ mail: 'off' });
    expect(service.state('github-5').available).toBe(false);
    await expect(service.change(anna, { use: 'account' })).rejects.toMatchObject({
      code: 'mail-not-configured',
    });
  });
});
