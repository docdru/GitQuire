import { describe, expect, it } from 'vitest';
import { INTERNAL_REQUEST_HEADER, internalSecret } from '../internal-request.ts';
import { createPersonTickets, PERSON_TICKET_HEADER, ticketOfRequest } from './ticket.ts';

describe('person tickets', () => {
  it('name the person only to the wiki they were issued for, and only for a while', () => {
    let at = 1000;
    const tickets = createPersonTickets({ now: () => at, lifetimeMs: 60_000 });
    const ticket = tickets.issue('github-1', 'github-7', 'anna');
    expect(tickets.personOf(ticket, 'github-1')).toEqual({ person: 'github-7', login: 'anna' });
    expect(tickets.personOf(ticket, 'github-2')).toBeUndefined();
    at += 60_000;
    expect(tickets.personOf(ticket, 'github-1')).toBeUndefined();
  });

  it('cannot be made or changed by an editor process', () => {
    const tickets = createPersonTickets();
    const other = createPersonTickets();
    const ticket = tickets.issue('github-1', 'github-7', 'anna');
    expect(other.personOf(ticket, 'github-1')).toBeUndefined();
    const [body, mac] = ticket.split('.');
    const forged = Buffer.from(
      JSON.stringify({ w: 'github-1', p: 'github-8', l: 'bob', e: Date.now() + 60_000 }),
    ).toString('base64url');
    expect(tickets.personOf(`${forged}.${mac}`, 'github-1')).toBeUndefined();
    expect(tickets.personOf(`${body}.x`, 'github-1')).toBeUndefined();
    expect(tickets.personOf(undefined, 'github-1')).toBeUndefined();
  });

  it('is read from a request only when the front door sent it', () => {
    const headers = { [PERSON_TICKET_HEADER]: 'abc' };
    expect(ticketOfRequest({ headers })).toBeUndefined();
    expect(
      ticketOfRequest({ headers: { ...headers, [INTERNAL_REQUEST_HEADER]: internalSecret() } }),
    ).toBe('abc');
  });
});
