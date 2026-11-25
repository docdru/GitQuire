import type { AccountAddress } from '../host/types.ts';
import { isAllowedRecipient, type MailConfig } from '../mail.ts';
import type { PeopleStore } from './store.ts';

export type AccountProblem = 'none' | 'refused' | 'unreachable';

export interface PendingAddress {
  address: string;
  codeHash: string;
  sentAt: string;
  attempts: number;
}

export interface MailRecord {
  login?: string;
  account?: { address: string; readAt: string };
  accountProblem?: AccountProblem;
  use?: 'account' | 'other';
  chosenAt?: string;
  other?: { address: string; confirmedAt: string };
  pending?: PendingAddress;
  since?: string;
  lastSeen?: string;
  confirmationsSent?: string[];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function texts(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

export function parseMailRecord(raw: unknown): MailRecord {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const record: MailRecord = {};
  const login = text(r.login);
  if (login !== undefined) record.login = login;
  const account = r.account as Record<string, unknown> | undefined;
  const accountAddress = text(account?.address);
  const accountRead = text(account?.readAt);
  if (accountAddress !== undefined && accountRead !== undefined) {
    record.account = { address: accountAddress, readAt: accountRead };
  }
  if (
    r.accountProblem === 'none' ||
    r.accountProblem === 'refused' ||
    r.accountProblem === 'unreachable'
  ) {
    record.accountProblem = r.accountProblem;
  }
  if (r.use === 'account' || r.use === 'other') record.use = r.use;
  const chosenAt = text(r.chosenAt);
  if (chosenAt !== undefined) record.chosenAt = chosenAt;
  const other = r.other as Record<string, unknown> | undefined;
  const otherAddress = text(other?.address);
  const confirmedAt = text(other?.confirmedAt);
  if (otherAddress !== undefined && confirmedAt !== undefined) {
    record.other = { address: otherAddress, confirmedAt };
  }
  const pending = r.pending as Record<string, unknown> | undefined;
  const pendingAddress = text(pending?.address);
  const codeHash = text(pending?.codeHash);
  const sentAt = text(pending?.sentAt);
  if (pendingAddress !== undefined && codeHash !== undefined && sentAt !== undefined) {
    record.pending = {
      address: pendingAddress,
      codeHash,
      sentAt,
      attempts: typeof pending?.attempts === 'number' ? pending.attempts : 0,
    };
  }
  const since = text(r.since);
  if (since !== undefined) record.since = since;
  const lastSeen = text(r.lastSeen);
  if (lastSeen !== undefined) record.lastSeen = lastSeen;
  const sent = texts(r.confirmationsSent);
  if (sent !== undefined) record.confirmationsSent = sent;
  return record;
}

export function readMailRecord(store: PeopleStore, person: string): MailRecord {
  return store.readJson(person, 'mail.json', parseMailRecord);
}

export function updateMailRecord(
  store: PeopleStore,
  person: string,
  change: (record: MailRecord) => MailRecord,
): MailRecord {
  return store.updateJson(person, 'mail.json', parseMailRecord, change);
}

export function withAccountAddress(
  record: MailRecord,
  login: string,
  found: AccountAddress,
  now: Date,
): MailRecord {
  const { account: _account, accountProblem: _problem, ...rest } = record;
  const next: MailRecord = { ...rest, login };
  if (found.state === 'found') {
    next.account = { address: found.address, readAt: now.toISOString() };
    return next;
  }
  if (found.state === 'unreachable') {
    if (record.account !== undefined) next.account = record.account;
    next.accountProblem = 'unreachable';
    return next;
  }
  next.accountProblem = found.state;
  return next;
}

export function recordAccountAddress(
  store: PeopleStore,
  person: string,
  login: string,
  found: AccountAddress,
  now: Date,
): MailRecord {
  return updateMailRecord(store, person, (record) => withAccountAddress(record, login, found, now));
}

export const UNCHECKED_ACCOUNT_ADDRESS_MS = 30 * 24 * 60 * 60 * 1000;

export type AccountOffer =
  | { offered: true; address: string }
  | { offered: false; why: AccountProblem | 'domain' | 'not-read' };

export function accountOffer(
  record: MailRecord,
  config: Pick<MailConfig, 'allowedDomains'> | undefined,
  now: number = Date.now(),
): AccountOffer {
  if (record.account === undefined) {
    return { offered: false, why: record.accountProblem ?? 'not-read' };
  }
  if (
    record.accountProblem === 'unreachable' &&
    now - Date.parse(record.account.readAt) > UNCHECKED_ACCOUNT_ADDRESS_MS
  ) {
    return { offered: false, why: 'unreachable' };
  }
  if (config !== undefined && !isAllowedRecipient(config, record.account.address)) {
    return { offered: false, why: 'domain' };
  }
  return { offered: true, address: record.account.address };
}

export function mailAddressOf(
  record: MailRecord,
  config: Pick<MailConfig, 'allowedDomains'> | undefined,
  now: number = Date.now(),
): string | undefined {
  if (record.use === 'account') {
    const offer = accountOffer(record, config, now);
    return offer.offered ? offer.address : undefined;
  }
  if (record.use === 'other' && record.other !== undefined) {
    if (config !== undefined && !isAllowedRecipient(config, record.other.address)) return undefined;
    return record.other.address;
  }
  return undefined;
}
