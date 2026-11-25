import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doorChatKeys, doorChatUsage } from '../chat/person-data.ts';
import { createPersonSocketHandler } from '../front-door/person-socket.ts';
import { listenTokenSocket } from '../front-door/token-socket.ts';
import { INTERNAL_REQUEST_HEADER, internalSecret } from '../internal-request.ts';
import { personChatData, personKeyStore } from './chat-data.ts';
import { doorAsker } from './door-client.ts';
import { personSettings } from './settings.ts';
import { createPeopleStore } from './store.ts';
import { createPersonTickets, PERSON_TICKET_HEADER } from './ticket.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

async function door() {
  const dir = mkdtempSync(join(tmpdir(), 'gq-chat-data-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPeopleStore(join(dir, 'people'));
  const tickets = createPersonTickets();
  const state = { wiki: 'github-1' };
  const data = personChatData(store, personKeyStore(store, 'p'.repeat(64)), {
    now: () => new Date('2026-11-25T10:00:00Z'),
  });
  const socket = await listenTokenSocket({
    person: createPersonSocketHandler({
      tickets,
      mayAsk: async () => true,
      settings: personSettings(store),
      handlers: [data.answer],
      log: silentLog,
    }),
    wikiOfSecret: (secret) => (secret === internalSecret() ? state.wiki : undefined),
    repoOf: () => undefined,
    tokenFor: async () => undefined,
    log: silentLog,
  });
  cleanups.push(() => socket.close());
  const ask = doorAsker(socket.path);
  const request = (wiki: string, person: string) => {
    state.wiki = wiki;
    return {
      headers: {
        [INTERNAL_REQUEST_HEADER]: internalSecret(),
        [PERSON_TICKET_HEADER]: tickets.issue(wiki, person, 'anna'),
      },
    } as unknown as IncomingMessage;
  };
  return { dir, store, keys: doorChatKeys(ask), usage: doorChatUsage(ask), request, state };
}

const anna = { id: 5, login: 'anna', name: 'Anna', avatarUrl: '' };

describe('AI keys and token usage per person', () => {
  it('works in every wiki of the account once the key is entered in one', async () => {
    const { keys, request } = await door();
    await keys.set(request('github-1', 'github-5'), anna, 'claude', KEY, new Date());
    expect(await keys.get(request('github-2', 'github-5'), anna, 'claude')).toBe(KEY);
    const info = await keys.info(request('github-2', 'github-5'), anna);
    expect(info.claude).toMatchObject({ configured: true, hint: `…${KEY.slice(-4)}` });
    expect(JSON.stringify(info)).not.toContain(KEY);
  });

  it('gives a wiki process only the key of the person whose request it serves (P8)', async () => {
    const { keys, request } = await door();
    await keys.set(request('github-1', 'github-5'), anna, 'claude', KEY, new Date());
    expect(await keys.get(request('github-1', 'github-6'), anna, 'claude')).toBeUndefined();
    expect(await keys.get(request('github-1', 'forgejo-5'), anna, 'claude')).toBeUndefined();
    const unticketed = {
      headers: { [INTERNAL_REQUEST_HEADER]: internalSecret() },
    } as unknown as IncomingMessage;
    await expect(keys.get(unticketed, anna, 'claude')).rejects.toThrow('no person ticket');
  });

  it('writes the key only sealed, in the person’s own folder (P8)', async () => {
    const { dir, keys, request } = await door();
    await keys.set(request('github-1', 'github-5'), anna, 'claude', KEY, new Date());
    expect(readdirSync(join(dir, 'people', 'github-5'))).toEqual(['ai-keys.json']);
    expect(readFileSync(join(dir, 'people', 'github-5', 'ai-keys.json'), 'utf8')).not.toContain(
      KEY,
    );
    await keys.remove(request('github-2', 'github-5'), anna, 'claude');
    expect(await keys.get(request('github-1', 'github-5'), anna, 'claude')).toBeUndefined();
  });

  it('counts usage over all wikis but lists chats only of the wiki it is asked in (P9)', async () => {
    const { usage, request } = await door();
    const entry = (chatId: string, title: string) => ({
      day: '2026-11-25',
      chatId,
      title,
      provider: 'claude' as const,
      model: 'claude-sonnet',
      inputTokens: 100,
      outputTokens: 10,
    });
    await usage.add(
      request('github-1', 'github-5'),
      anna,
      entry('chatAAAAAAAAAAAA', 'Budget in A'),
    );
    await usage.add(
      request('github-2', 'github-5'),
      anna,
      entry('chatBBBBBBBBBBBB', 'Secret plan in B'),
    );
    const inA = await usage.report(request('github-1', 'github-5'), anna, new Date());
    expect(inA.total).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(inA.chats.map((chat) => chat.title)).toEqual(['Budget in A']);
    expect(JSON.stringify(inA)).not.toContain('Secret plan');
  });
});
