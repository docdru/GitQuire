import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const INTERNAL_REQUEST_HEADER = 'x-gitquire-internal';

const secret = Buffer.from(randomBytes(32).toString('hex'));

export function internalRequestHeaders(): Record<string, string> {
  return { [INTERNAL_REQUEST_HEADER]: secret.toString() };
}

export function isInternalRequest(req: IncomingMessage): boolean {
  const value = req.headers[INTERNAL_REQUEST_HEADER];
  if (typeof value !== 'string') return false;
  const given = Buffer.from(value);
  return given.length === secret.length && timingSafeEqual(given, secret);
}
