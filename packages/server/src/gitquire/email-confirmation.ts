import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MailConfig, MailMessage } from './mail.ts';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export const CONFIRMATION_VALID_MS = 24 * 60 * 60 * 1000;
export const CONFIRMATION_RESEND_MS = 60 * 1000;
export const MAX_CONFIRMATION_ATTEMPTS = 5;
export const MAX_CONFIRMATIONS_PER_PERSON_PER_DAY = 5;
export const MAX_CONFIRMATIONS_PER_HOUR = 30;
export const MAX_CONFIRMATIONS_PER_DAY = 100;
export const MAX_CONFIRMATIONS_PER_ADDRESS_PER_DAY = 3;

export function confirmationKeyPath(projectDir: string): string {
  return join(projectDir, '.gitquire', 'local', 'gitquire', 'mail-code-key');
}

function storedKey(file: string): string | undefined {
  try {
    const key = readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

export function confirmationKey(secret: string | undefined, keyFile: string): string {
  if (secret !== undefined && secret.trim() !== '') return secret;
  const existing = storedKey(keyFile);
  if (existing !== undefined) return existing;
  const fresh = randomBytes(32).toString('hex');
  mkdirSync(dirname(keyFile), { recursive: true });
  const temporary = `${keyFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${fresh}\n`, { mode: 0o600 });
  renameSync(temporary, keyFile);
  return fresh;
}

export function newConfirmationCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeConfirmationCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function displayConfirmationCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function hashConfirmationCode(key: string, userId: number, code: string): string {
  const normalized = normalizeConfirmationCode(code);
  return createHmac('sha256', key).update(`code:${userId}:${normalized}`).digest('hex');
}

export function recipientKey(key: string, address: string): string {
  return createHmac('sha256', key).update(`to:${address.trim().toLowerCase()}`).digest('hex');
}

export function confirmationMail(
  config: Pick<MailConfig, 'externalUrl'>,
  to: string,
  login: string,
  code: string,
  hostLabel = 'GitHub',
): MailMessage {
  const where = config.externalUrl === undefined ? 'GitQuire' : `GitQuire at ${config.externalUrl}`;
  const lines = [
    `The ${hostLabel} user "${login}" asked ${where} to send mention notifications to this address.`,
    '',
    `Confirmation code: ${displayConfirmationCode(code)}`,
    '',
    'Enter the code in GitQuire under Settings → Notifications within 24 hours.',
    '',
    'If this was not you, ignore this mail.',
    'No mention emails will be sent to this address unless the code is entered.',
  ];
  return {
    to,
    subject: 'Confirm your address for GitQuire mentions',
    text: `${lines.join('\n')}\n`,
  };
}
