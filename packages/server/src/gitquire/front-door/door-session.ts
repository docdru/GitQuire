import type { HostPerson } from '../host/types.ts';
import { decodeSigned, encodeSigned } from '../signed-cookie.ts';

export interface DoorAccount {
  person: HostPerson;
  exp: number;
}

export type DoorAccounts = ReadonlyMap<string, DoorAccount>;

type CompactAccount = [number, string, string, string, number];

interface SessionV1 extends HostPerson {
  v: 1;
  exp: number;
}

interface SessionV2 {
  v: 2;
  a: Record<string, CompactAccount>;
}

export const MAX_SESSION_COOKIE_BYTES = 3800;

function isPersonFields(v: Record<string, unknown>): boolean {
  return (
    typeof v.id === 'number' &&
    typeof v.login === 'string' &&
    typeof v.name === 'string' &&
    typeof v.avatarUrl === 'string' &&
    typeof v.exp === 'number'
  );
}

function isCompact(value: unknown): value is CompactAccount {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'string' &&
    typeof value[3] === 'string' &&
    typeof value[4] === 'number'
  );
}

export function readDoorSession(
  secret: string,
  raw: string | undefined,
  options: { nowSeconds: number; primaryKey: string; keys: ReadonlySet<string> },
): Map<string, DoorAccount> {
  const accounts = new Map<string, DoorAccount>();
  const decoded = decodeSigned(secret, raw);
  if (typeof decoded !== 'object' || decoded === null) return accounts;
  const v = decoded as Record<string, unknown>;
  if (v.v === 1 && isPersonFields(v)) {
    const one = v as unknown as SessionV1;
    if (one.exp > options.nowSeconds && options.keys.has(options.primaryKey)) {
      accounts.set(options.primaryKey, {
        person: { id: one.id, login: one.login, name: one.name, avatarUrl: one.avatarUrl },
        exp: one.exp,
      });
    }
    return accounts;
  }
  if (v.v !== 2 || typeof v.a !== 'object' || v.a === null) return accounts;
  for (const [key, entry] of Object.entries(v.a as Record<string, unknown>)) {
    if (!options.keys.has(key) || !isCompact(entry) || entry[4] <= options.nowSeconds) continue;
    const [id, login, name, avatarUrl, exp] = entry;
    accounts.set(key, { person: { id, login, name, avatarUrl }, exp });
  }
  return accounts;
}

export function writeDoorSession(
  secret: string,
  accounts: DoorAccounts,
  primaryKey: string,
): string {
  const only = accounts.size === 1 ? accounts.get(primaryKey) : undefined;
  if (only !== undefined) {
    const payload: SessionV1 = { v: 1, ...only.person, exp: only.exp };
    return encodeSigned(secret, payload);
  }
  const a: Record<string, CompactAccount> = {};
  for (const [key, { person, exp }] of accounts) {
    const kept = trimmedForCookie(person);
    a[key] = [kept.id, kept.login, kept.name, kept.avatarUrl, exp];
  }
  const payload: SessionV2 = { v: 2, a };
  return encodeSigned(secret, payload);
}

function trimmedForCookie(person: HostPerson): HostPerson {
  return {
    ...person,
    name: person.name.slice(0, 200),
    avatarUrl: person.avatarUrl.length > 500 ? '' : person.avatarUrl,
  };
}
