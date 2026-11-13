import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const INTERNAL_REQUEST_HEADER = 'x-gitquire-internal';
export const INTERNAL_SECRET_ENV = 'GITQUIRE_INTERNAL_SECRET';

const inherited = process.env[INTERNAL_SECRET_ENV]?.trim();
delete process.env[INTERNAL_SECRET_ENV];
const secret = Buffer.from(
  inherited !== undefined && inherited.length >= 32 ? inherited : randomBytes(32).toString('hex'),
);

export function internalSecret(): string {
  return secret.toString();
}

export function internalRequestHeaders(): Record<string, string> {
  return { [INTERNAL_REQUEST_HEADER]: secret.toString() };
}

export function isInternalRequest(req: IncomingMessage): boolean {
  const value = req.headers[INTERNAL_REQUEST_HEADER];
  if (typeof value !== 'string') return false;
  const given = Buffer.from(value);
  return given.length === secret.length && timingSafeEqual(given, secret);
}
