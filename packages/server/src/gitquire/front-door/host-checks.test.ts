import { describe, expect, it } from 'vitest';
import type { DoorHost, SelfCheck } from '../host/types.ts';
import type { WikiAccess } from './access.ts';
import { entryForTest, hostSettingsForTest } from './door-hosts.test-helper.ts';
import { checkHosts, hostSummary, warnUnknownNames } from './host-checks.ts';

const base = {
  host: 'github' as const,
  webUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
  clientId: 'client-id-value',
  clientSecret: 'client-secret-value',
  githubApp: { appId: '7', privateKeyPem: 'pem-value' },
  forgejoBotToken: undefined,
  allowedOwners: new Set(['team']),
  serverAdmins: new Set(['alice', 'docdur']),
};

function entry(key: string, host: Partial<DoorHost>, extra = {}) {
  return entryForTest({
    settings: hostSettingsForTest(base, { key, ...extra }),
    host: host as DoorHost,
    access: {} as WikiAccess,
    owners: { names: new Set(['team']), pinned: () => ({}), pin: () => {} },
  });
}

function recorder() {
  const lines: { fields: Record<string, unknown>; message: string }[] = [];
  const log = {
    info: (fields: object, message?: string) =>
      lines.push({ fields: fields as Record<string, unknown>, message: message ?? '' }),
    warn: (fields: object, message?: string) =>
      lines.push({ fields: fields as Record<string, unknown>, message: message ?? '' }),
    error: () => {},
  };
  return { lines, log };
}

describe('the start summary (C1)', () => {
  it('names key, kind, address, callback, owners and administrators, and no secret (O7)', () => {
    const summary = hostSummary(entry('github', {}), new URL('https://wiki.example.org'));
    expect(summary).toEqual({
      host: 'github',
      kind: 'github',
      label: 'GitHub',
      address: 'https://github.com',
      callback: 'https://wiki.example.org/auth/github/callback',
      allowedOwners: ['team'],
      admins: ['alice', 'docdur'],
    });
    const text = JSON.stringify(summary);
    for (const secret of ['client-id-value', 'client-secret-value', 'pem-value']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('the start check of every host', () => {
  const check = (result: SelfCheck) => ({ selfCheck: async () => result });

  it('stops for a host whose settings are wrong, naming it', async () => {
    const { log } = recorder();
    await expect(
      checkHosts(
        [
          entry('github', check({ ok: true })),
          entry('forgejo', check({ ok: false, unreachable: false, problems: ['bad token'] }), {
            kind: 'forgejo',
          }),
        ],
        log,
      ),
    ).rejects.toThrow(/forgejo: bad token/);
  });

  it('starts while a host cannot be reached, with a warning', async () => {
    const { lines, log } = recorder();
    await checkHosts(
      [
        entry('github', check({ ok: false, unreachable: true, problems: ['timeout'] })),
        entry('forgejo', check({ ok: true }), { kind: 'forgejo' }),
      ],
      log,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({ host: 'github' });
  });
});

describe('names the host does not know (C2)', () => {
  it('warns about an administrator or owner the host does not know, and only those', async () => {
    const { lines, log } = recorder();
    const known = new Set(['alice', 'team']);
    await warnUnknownNames(
      [
        entry('github', {
          accountExists: async (name) => (known.has(name) ? 'found' : 'missing'),
        }),
        entry('forgejo', { accountExists: async () => 'unknown' }, { kind: 'forgejo' }),
      ],
      log,
    );
    expect(lines.map((line) => line.fields)).toEqual([
      { host: 'github', setting: 'ADMINS', name: 'docdur' },
    ]);
    expect(lines[0]?.message).toContain('does not know "docdur"');
  });
});
