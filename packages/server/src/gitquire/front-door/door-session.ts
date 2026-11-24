import { createHash } from 'node:crypto';
import type { HostPerson } from '../host/types.ts';
import { decodeSigned, encodeSigned } from '../signed-cookie.ts';

export interface DoorAccount {
  person: HostPerson;
  exp: number;
}

export type DoorAccounts = ReadonlyMap<string, DoorAccount>;

type CompactAccount = [number, string, string, string, number, string];

interface SessionV1 extends HostPerson {
  v: 1;
  exp: number;
  h?: string;
}

interface SessionV2 {
  v: 2;
  a: Record<string, CompactAccount>;
}

export const MAX_SESSION_COOKIE_BYTES = 3800;

export function hostFingerprint(host: { kind: string; webUrl: string }): string {
  return createHash('sha256')
    .update(`${host.kind}\n${new URL(host.webUrl).origin}`)
    .digest('base64url')
    .slice(0, 8);
}

export interface SessionHosts {
  primaryKey: string;
  fingerprints: ReadonlyMap<string, string>;
}

function isPersonFields(v: Record<string, unknown>): boolean {
  return (
    typeof v.id === 'number' &&
    typeof v.login === 'string' &&
    typeof v.name === 'string' &&
    typeof v.avatarUrl === 'string' &&
    typeof v.exp === 'number' &&
    (v.h === undefined || typeof v.h === 'string')
  );
}

function isCompact(value: unknown): value is CompactAccount {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'string' &&
    typeof value[3] === 'string' &&
    typeof value[4] === 'number' &&
    typeof value[5] === 'string'
  );
}

export function readDoorSession(
  secret: string,
  raw: string | undefined,
  options: SessionHosts & { nowSeconds: number },
): Map<string, DoorAccount> {
  const accounts = new Map<string, DoorAccount>();
  const decoded = decodeSigned(secret, raw);
  if (typeof decoded !== 'object' || decoded === null) return accounts;
  const v = decoded as Record<string, unknown>;
  if (v.v === 1 && isPersonFields(v)) {
    const one = v as unknown as SessionV1;
    const expected = options.fingerprints.get(options.primaryKey);
    if (expected === undefined || one.exp <= options.nowSeconds) return accounts;
    if (one.h !== undefined && one.h !== expected) return accounts;
    accounts.set(options.primaryKey, {
      person: { id: one.id, login: one.login, name: one.name, avatarUrl: one.avatarUrl },
      exp: one.exp,
    });
    return accounts;
  }
  if (v.v !== 2 || typeof v.a !== 'object' || v.a === null) return accounts;
  for (const [key, entry] of Object.entries(v.a as Record<string, unknown>)) {
    const expected = options.fingerprints.get(key);
    if (expected === undefined || !isCompact(entry) || entry[4] <= options.nowSeconds) continue;
    if (entry[5] !== expected) continue;
    const [id, login, name, avatarUrl, exp] = entry;
    accounts.set(key, { person: { id, login, name, avatarUrl }, exp });
  }
  return accounts;
}

function encodeV2(
  secret: string,
  accounts: DoorAccounts,
  fingerprints: ReadonlyMap<string, string>,
  keep: (person: HostPerson) => HostPerson,
): string {
  const a: Record<string, CompactAccount> = {};
  for (const [key, { person, exp }] of accounts) {
    const kept = keep(person);
    a[key] = [kept.id, kept.login, kept.name, kept.avatarUrl, exp, fingerprints.get(key) ?? ''];
  }
  const payload: SessionV2 = { v: 2, a };
  return encodeSigned(secret, payload);
}

const SHRINK: readonly ((person: HostPerson) => HostPerson)[] = [
  (person) => ({
    ...person,
    name: person.name.slice(0, 200),
    avatarUrl: person.avatarUrl.length > 500 ? '' : person.avatarUrl,
  }),
  (person) => ({ ...person, name: person.name.slice(0, 40), avatarUrl: '' }),
  (person) => ({ ...person, name: '', avatarUrl: '' }),
];

export function writeDoorSession(
  secret: string,
  accounts: DoorAccounts,
  hosts: SessionHosts,
): string {
  const only = accounts.size === 1 ? accounts.get(hosts.primaryKey) : undefined;
  if (only !== undefined) {
    const h = hosts.fingerprints.get(hosts.primaryKey);
    const payload: SessionV1 = {
      v: 1,
      ...only.person,
      exp: only.exp,
      ...(h === undefined ? {} : { h }),
    };
    return encodeSigned(secret, payload);
  }
  let encoded = '';
  for (const keep of SHRINK) {
    encoded = encodeV2(secret, accounts, hosts.fingerprints, keep);
    if (encodeURIComponent(encoded).length <= MAX_SESSION_COOKIE_BYTES) return encoded;
  }
  return encoded;
}
