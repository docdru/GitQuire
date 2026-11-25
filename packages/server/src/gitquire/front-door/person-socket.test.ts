import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { internalSecret } from '../internal-request.ts';
import { doorAsker } from '../people/door-client.ts';
import { personSettings } from '../people/settings.ts';
import { createPeopleStore } from '../people/store.ts';
import { createPersonTickets } from '../people/ticket.ts';
import { createPersonSocketHandler } from './person-socket.ts';
import { listenTokenSocket, type TokenSocket } from './token-socket.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function door(wikiOf: (secret: string) => string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'gq-person-socket-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPeopleStore(join(dir, 'people'));
  const tickets = createPersonTickets();
  const socket: TokenSocket = await listenTokenSocket({
    person: createPersonSocketHandler({ tickets, settings: personSettings(store), log: silentLog }),
    wikiOfSecret: wikiOf,
    repoOf: () => undefined,
    tokenFor: async () => undefined,
    log: silentLog,
  });
  cleanups.push(() => socket.close());
  return { store, tickets, ask: doorAsker(socket.path), path: socket.path };
}

function askAs(
  socket: string,
  secret: string,
  method: string,
  path: string,
  ticket: string,
  body: unknown,
) {
  return new Promise<number>((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath: socket,
        path: `/person/${path}`,
        method,
        headers: {
          'x-gitquire-internal': secret,
          'x-gitquire-person-ticket': ticket,
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('per-person questions on the door socket', () => {
  it('answers a wiki process only for the person of a ticket issued to that wiki', async () => {
    const mine = internalSecret();
    let wiki = 'github-1';
    const { tickets, ask } = await door((secret) => (secret === mine ? wiki : undefined));
    const forA = tickets.issue('github-1', 'github-7');
    expect((await ask('GET', 'settings', forA)).status).toBe(200);
    wiki = 'github-2';
    expect((await ask('GET', 'settings', forA)).status).toBe(403);
    expect((await ask('GET', 'settings', '')).status).toBe(403);
    expect((await ask('GET', 'settings', tickets.issue('github-2', 'github-7'))).status).toBe(200);
  });

  it('refuses a process it does not know', async () => {
    const { tickets, ask } = await door(() => undefined);
    const answer = await ask('GET', 'settings', tickets.issue('github-1', 'github-7'));
    expect(answer).toEqual({ status: 403, body: { error: 'unknown-wiki' } });
  });

  it('keeps every change a person makes from two wikis at once, because only the front door writes (P6)', async () => {
    const mine = internalSecret();
    const wikis: Record<string, string> = { [mine]: 'github-1', 'secret-b': 'github-2' };
    const { store, tickets, ask, path } = await door((secret) => wikis[secret]);
    const inA = tickets.issue('github-1', 'github-7');
    const inB = tickets.issue('github-2', 'github-7');
    const writes: Promise<number>[] = [];
    for (let round = 0; round < 10; round += 1) {
      writes.push(
        round % 2 === 0
          ? askAs(path, mine, 'PUT', 'settings', inA, {
              yaml: `editor:\n  spellcheck: ${round % 4 === 0}\n`,
            })
          : askAs(path, 'secret-b', 'PUT', 'agent-mode', inB, {
              mode: 'draft',
            }),
      );
    }
    expect(new Set(await Promise.all(writes))).toEqual(new Set([200]));
    const settings = personSettings(store);
    expect(settings.read('github-7')).toMatch(/^editor:\n {2}spellcheck: (true|false)\n$/);
    expect(settings.agentMode('github-7')).toBe('draft');
    expect((await ask('GET', 'agent-mode', inA)).body).toEqual({ mode: 'draft' });
  });

  it('checks settings the same way as before', async () => {
    const mine = internalSecret();
    const { tickets, ask } = await door((secret) => (secret === mine ? 'github-1' : undefined));
    const ticket = tickets.issue('github-1', 'github-7');
    expect(await ask('PUT', 'settings', ticket, { yaml: 'a: [' })).toEqual({
      status: 400,
      body: { error: 'settings-invalid-yaml' },
    });
    expect(await ask('PUT', 'agent-mode', ticket, { mode: 'sometimes' })).toEqual({
      status: 400,
      body: { error: 'invalid-mode' },
    });
    expect((await ask('GET', 'nothing', ticket)).status).toBe(404);
  });
});
