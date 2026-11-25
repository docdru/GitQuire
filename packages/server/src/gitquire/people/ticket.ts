import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isInternalRequest } from '../internal-request.ts';
import { decodeSigned, encodeSigned } from '../signed-cookie.ts';
import { isPersonId } from './store.ts';

export const PERSON_TICKET_HEADER = 'x-gitquire-person-ticket';
export const PERSON_TICKET_LIFETIME_MS = 15 * 60 * 1000;

interface TicketBody {
  w: string;
  p: string;
  e: number;
}

export interface PersonTickets {
  issue: (wikiKey: string, person: string) => string;
  personOf: (ticket: string | undefined, wikiKey: string) => string | undefined;
}

export function createPersonTickets(
  options: { key?: string; now?: () => number; lifetimeMs?: number } = {},
): PersonTickets {
  const key = options.key ?? randomBytes(32).toString('hex');
  const now = options.now ?? Date.now;
  const lifetime = options.lifetimeMs ?? PERSON_TICKET_LIFETIME_MS;
  return {
    issue: (wikiKey, person) =>
      encodeSigned(key, { w: wikiKey, p: person, e: now() + lifetime } satisfies TicketBody),
    personOf: (ticket, wikiKey) => {
      const body = decodeSigned(key, ticket) as Partial<TicketBody> | undefined;
      if (typeof body !== 'object' || body === null) return undefined;
      if (body.w !== wikiKey || !isPersonId(body.p)) return undefined;
      if (typeof body.e !== 'number' || body.e <= now()) return undefined;
      return body.p;
    },
  };
}

export function ticketOfRequest(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const raw = req.headers[PERSON_TICKET_HEADER];
  if (typeof raw !== 'string' || raw === '' || !isInternalRequest(req)) return undefined;
  return raw;
}
