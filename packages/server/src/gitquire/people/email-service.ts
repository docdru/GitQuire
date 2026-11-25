import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import {
  CONFIRMATION_RESEND_MS,
  CONFIRMATION_VALID_MS,
  confirmationMail,
  hashConfirmationCode,
  MAX_CONFIRMATION_ATTEMPTS,
  MAX_CONFIRMATIONS_PER_ADDRESS_PER_DAY,
  MAX_CONFIRMATIONS_PER_DAY,
  MAX_CONFIRMATIONS_PER_HOUR,
  MAX_CONFIRMATIONS_PER_PERSON_PER_DAY,
  newConfirmationCode,
  normalizeConfirmationCode,
  recipientKey,
} from '../email-confirmation.ts';
import {
  isAllowedRecipient,
  isEmailAddress,
  type MailConfig,
  type MailConfigResult,
  type MailMessage,
} from '../mail.ts';
import { safeEqual } from '../signed-cookie.ts';
import {
  type AccountOffer,
  accountOffer,
  type MailRecord,
  mailAddressOf,
  readMailRecord,
  updateMailRecord,
} from './mail.ts';
import type { PeopleStore } from './store.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface EmailPerson {
  person: string;
  login: string;
  hostLabel: string;
}

export interface EmailState {
  available: boolean;
  address: string | null;
  pending: string | null;
  use: 'account' | 'other' | null;
  account: { address: string | null; why: Exclude<AccountOffer, { offered: true }>['why'] | null };
  other: string | null;
  stopped: 'account-gone' | null;
}

export class EmailRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Counters {
  recipients: Record<string, string[]>;
  sent: string[];
}

export interface EmailServiceDeps {
  store: PeopleStore;
  countersFile: string;
  mail: MailConfigResult;
  codeKey: () => string;
  send: (config: MailConfig, message: MailMessage) => Promise<void>;
  log: Pick<GateLogger, 'info' | 'warn'>;
  onSwitchedOn?: (person: string, login: string, since: string) => void;
  now?: () => number;
}

export interface EmailService {
  state: (person: string) => EmailState;
  seen: (who: EmailPerson) => void;
  change: (who: EmailPerson, body: Record<string, unknown>) => Promise<EmailState>;
  confirm: (who: EmailPerson, body: Record<string, unknown>) => EmailState;
}

function readCounters(file: string): Counters {
  if (!existsSync(file)) return { recipients: {}, sent: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Counters>;
    const recipients: Record<string, string[]> = {};
    for (const [key, stamps] of Object.entries(raw.recipients ?? {})) {
      if (Array.isArray(stamps)) recipients[key] = stamps.filter((s) => typeof s === 'string');
    }
    const sent = Array.isArray(raw.sent) ? raw.sent.filter((s) => typeof s === 'string') : [];
    return { recipients, sent };
  } catch {
    return { recipients: {}, sent: [] };
  }
}

function writeCounters(file: string, counters: Counters): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(counters)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

const SEEN_WRITE_GAP_MS = DAY_MS;

export function createEmailService(deps: EmailServiceDeps): EmailService {
  const now = deps.now ?? Date.now;
  const config = deps.mail.kind === 'on' ? deps.mail.config : undefined;

  function state(person: string): EmailState {
    const record = readMailRecord(deps.store, person);
    const offer = accountOffer(record, config, now());
    const pending =
      record.pending !== undefined &&
      now() - Date.parse(record.pending.sentAt) <= CONFIRMATION_VALID_MS
        ? record.pending.address
        : null;
    const address = mailAddressOf(record, config, now()) ?? null;
    return {
      available: config !== undefined,
      address,
      pending,
      use: record.use ?? null,
      account: offer.offered
        ? { address: offer.address, why: null }
        : { address: null, why: offer.why },
      other: record.other?.address ?? null,
      stopped: record.use === 'account' && !offer.offered ? 'account-gone' : null,
    };
  }

  function switchOn(who: EmailPerson, use: 'account' | 'other', extra: Partial<MailRecord> = {}) {
    let since: string | undefined;
    let fresh = false;
    updateMailRecord(deps.store, who.person, (record) => {
      fresh = record.use === undefined || record.since === undefined;
      since = fresh ? new Date(now()).toISOString() : record.since;
      return {
        ...record,
        ...extra,
        login: who.login,
        use,
        since,
        lastSeen: new Date(now()).toISOString(),
      };
    });
    if (fresh && since !== undefined) deps.onSwitchedOn?.(who.person, who.login, since);
  }

  function checkBudget(who: EmailPerson, toKey: string): void {
    const record = readMailRecord(deps.store, who.person);
    const last = record.confirmationsSent?.at(-1);
    const sinceLast = last === undefined ? Infinity : now() - Date.parse(last);
    if (sinceLast < CONFIRMATION_RESEND_MS) {
      throw new EmailRequestError(
        429,
        'resend-too-soon',
        'Wait a minute before asking for another code.',
      );
    }
    const dayAgo = new Date(now() - DAY_MS).toISOString();
    const hourAgo = new Date(now() - HOUR_MS).toISOString();
    const counters = readCounters(deps.countersFile);
    const mine = (record.confirmationsSent ?? []).filter((at) => at >= dayAgo).length;
    const toAddress = (counters.recipients[toKey] ?? []).filter((at) => at >= dayAgo).length;
    const lastHour = counters.sent.filter((at) => at >= hourAgo).length;
    const lastDay = counters.sent.filter((at) => at >= dayAgo).length;
    if (
      mine >= MAX_CONFIRMATIONS_PER_PERSON_PER_DAY ||
      toAddress >= MAX_CONFIRMATIONS_PER_ADDRESS_PER_DAY ||
      lastHour >= MAX_CONFIRMATIONS_PER_HOUR ||
      lastDay >= MAX_CONFIRMATIONS_PER_DAY
    ) {
      throw new EmailRequestError(
        429,
        'too-many-codes',
        'Too many confirmation mails. Try again later.',
      );
    }
  }

  function reserve(who: EmailPerson, toKey: string): void {
    const stamp = new Date(now()).toISOString();
    const dayAgo = new Date(now() - DAY_MS).toISOString();
    const counters = readCounters(deps.countersFile);
    const recipients: Record<string, string[]> = {};
    for (const [key, stamps] of Object.entries(counters.recipients)) {
      const kept = stamps.filter((at) => at >= dayAgo);
      if (kept.length > 0) recipients[key] = kept;
    }
    recipients[toKey] = [...(recipients[toKey] ?? []), stamp];
    writeCounters(deps.countersFile, {
      recipients,
      sent: [...counters.sent.filter((at) => at >= dayAgo), stamp],
    });
    updateMailRecord(deps.store, who.person, (record) => ({
      ...record,
      login: who.login,
      confirmationsSent: [...(record.confirmationsSent ?? []).filter((at) => at >= dayAgo), stamp],
    }));
  }

  async function sendCode(who: EmailPerson, address: string): Promise<void> {
    if (config === undefined) {
      throw new EmailRequestError(409, 'mail-not-configured', 'This server cannot send email.');
    }
    const toKey = recipientKey(deps.codeKey(), address);
    checkBudget(who, toKey);
    reserve(who, toKey);
    const code = newConfirmationCode();
    try {
      await deps.send(config, confirmationMail(config, address, who.login, code, who.hostLabel));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        { reason: reason.split(address).join('<address>'), login: who.login },
        '[gitquire-mail] confirmation mail failed',
      );
      throw new EmailRequestError(502, 'mail-failed', 'The confirmation mail could not be sent.');
    }
    const stamp = new Date(now()).toISOString();
    updateMailRecord(deps.store, who.person, (record) => ({
      ...record,
      login: who.login,
      pending: {
        address,
        codeHash: hashConfirmationCode(deps.codeKey(), who.person, code),
        sentAt: stamp,
        attempts: 0,
      },
    }));
    deps.log.info({ login: who.login }, '[gitquire-mail] confirmation mail sent');
  }

  async function change(who: EmailPerson, body: Record<string, unknown>): Promise<EmailState> {
    if (body.cancel === true) {
      updateMailRecord(deps.store, who.person, ({ pending: _pending, ...record }) => record);
      return state(who.person);
    }
    if (body.use === null || body.address === null) {
      updateMailRecord(deps.store, who.person, ({ use: _use, since: _since, ...record }) => ({
        ...record,
        login: who.login,
      }));
      deps.log.info({ login: who.login }, '[gitquire-mail] mention email turned off');
      return state(who.person);
    }
    if (body.use === 'account') {
      if (config === undefined) {
        throw new EmailRequestError(409, 'mail-not-configured', 'This server cannot send email.');
      }
      const offer = accountOffer(readMailRecord(deps.store, who.person), config, now());
      if (!offer.offered) {
        throw new EmailRequestError(
          409,
          'no-account-address',
          'Your account has no address GitQuire may use.',
        );
      }
      switchOn(who, 'account');
      deps.log.info(
        { login: who.login },
        '[gitquire-mail] mention email turned on for the account address',
      );
      return state(who.person);
    }
    if (body.use === 'other') {
      const record = readMailRecord(deps.store, who.person);
      if (
        record.other === undefined ||
        config === undefined ||
        !isAllowedRecipient(config, record.other.address)
      ) {
        throw new EmailRequestError(409, 'no-other-address', 'Confirm another address first.');
      }
      switchOn(who, 'other');
      return state(who.person);
    }
    if (config === undefined) {
      throw new EmailRequestError(409, 'mail-not-configured', 'This server cannot send email.');
    }
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (!isEmailAddress(address)) {
      throw new EmailRequestError(400, 'invalid-address', 'Enter a valid email address.');
    }
    if (!isAllowedRecipient(config, address)) {
      throw new EmailRequestError(
        400,
        'address-not-allowed',
        'This server does not mail that domain.',
      );
    }
    const record = readMailRecord(deps.store, who.person);
    if (
      record.other !== undefined &&
      record.other.address.toLowerCase() === address.toLowerCase()
    ) {
      updateMailRecord(deps.store, who.person, ({ pending: _pending, ...rest }) => rest);
      switchOn(who, 'other');
      return state(who.person);
    }
    await sendCode(who, address);
    return state(who.person);
  }

  function confirm(who: EmailPerson, body: Record<string, unknown>): EmailState {
    const code = typeof body.code === 'string' ? normalizeConfirmationCode(body.code) : '';
    if (code === '')
      throw new EmailRequestError(400, 'invalid-code', 'Enter the code from the mail.');
    const record = readMailRecord(deps.store, who.person);
    const pending = record.pending;
    if (pending === undefined) {
      throw new EmailRequestError(
        409,
        'nothing-to-confirm',
        'There is no address waiting for a code.',
      );
    }
    const { pending: _dropped, ...rest } = record;
    if (now() - Date.parse(pending.sentAt) > CONFIRMATION_VALID_MS) {
      updateMailRecord(deps.store, who.person, () => rest);
      throw new EmailRequestError(410, 'code-expired', 'The code has expired. Ask for a new one.');
    }
    if (!safeEqual(pending.codeHash, hashConfirmationCode(deps.codeKey(), who.person, code))) {
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_CONFIRMATION_ATTEMPTS) {
        updateMailRecord(deps.store, who.person, () => rest);
        throw new EmailRequestError(
          429,
          'too-many-tries',
          'Too many wrong codes. Ask for a new one.',
        );
      }
      updateMailRecord(deps.store, who.person, () => ({
        ...record,
        pending: { ...pending, attempts },
      }));
      throw new EmailRequestError(400, 'wrong-code', 'That code is not right.');
    }
    updateMailRecord(deps.store, who.person, () => rest);
    switchOn(who, 'other', {
      other: { address: pending.address, confirmedAt: new Date(now()).toISOString() },
    });
    deps.log.info({ login: who.login }, '[gitquire-mail] mention email confirmed');
    return state(who.person);
  }

  return {
    state,
    seen: (who) => {
      const record = readMailRecord(deps.store, who.person);
      if (record.use === undefined) return;
      const last = record.lastSeen === undefined ? 0 : Date.parse(record.lastSeen);
      if (now() - last < SEEN_WRITE_GAP_MS && record.login === who.login) return;
      updateMailRecord(deps.store, who.person, (current) => ({
        ...current,
        login: who.login,
        lastSeen: new Date(now()).toISOString(),
      }));
    },
    change,
    confirm,
  };
}
