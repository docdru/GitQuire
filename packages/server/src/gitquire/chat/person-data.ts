import type { IncomingMessage } from 'node:http';
import type { SessionUser } from '../access-gate.ts';
import type { PersonChatData } from '../people/chat-data.ts';
import { type AskDoor, DoorUnavailableError } from '../people/door-client.ts';
import { personId } from '../people/store.ts';
import { ticketOfRequest } from '../people/ticket.ts';
import type { ChatKeyStore, SealedKeyStore, StoredKeyInfo } from './key-store.ts';
import type { ChatProvider } from './models.ts';
import type { ChatUsageStore, UsageEntry, UsageReport } from './usage.ts';

export interface ChatKeys {
  info(req: IncomingMessage, user: SessionUser): Promise<Record<ChatProvider, StoredKeyInfo>>;
  get(req: IncomingMessage, user: SessionUser, provider: ChatProvider): Promise<string | undefined>;
  set(
    req: IncomingMessage,
    user: SessionUser,
    provider: ChatProvider,
    key: string,
    now: Date,
  ): Promise<StoredKeyInfo>;
  remove(req: IncomingMessage, user: SessionUser, provider: ChatProvider): Promise<void>;
}

export interface ChatUsage {
  add(req: IncomingMessage, user: SessionUser, entry: UsageEntry): Promise<void>;
  report(req: IncomingMessage, user: SessionUser, now: Date): Promise<UsageReport>;
  purgeExpired(now: Date): number;
}

export function localChatKeys(store: ChatKeyStore): ChatKeys {
  return {
    info: async (_req, user) => store.info(user.id),
    get: async (_req, user, provider) => store.get(user.id, provider),
    set: async (_req, user, provider, key, now) => store.set(user.id, provider, key, now),
    remove: async (_req, user, provider) => store.remove(user.id, provider),
  };
}

export function localChatUsage(store: ChatUsageStore): ChatUsage {
  return {
    add: async (_req, user, entry) => store.add(user.id, entry),
    report: async (_req, user, now) => store.report(user.id, now),
    purgeExpired: (now) => store.purgeExpired(now),
  };
}

function ticket(req: IncomingMessage): string {
  const found = ticketOfRequest(req);
  if (found === undefined) throw new DoorUnavailableError('This request carries no person ticket.');
  return found;
}

async function answered<T>(ask: ReturnType<AskDoor>): Promise<T> {
  const answer = await ask;
  if (answer.status !== 200) {
    throw new DoorUnavailableError(`The front door answered ${answer.status}.`);
  }
  return answer.body as T;
}

export function doorChatKeys(ask: AskDoor): ChatKeys {
  return {
    info: (req) => answered(ask('GET', 'ai-keys', ticket(req))),
    get: async (req, _user, provider) =>
      (await answered<{ key: string | null }>(ask('GET', `ai-keys/${provider}`, ticket(req))))
        .key ?? undefined,
    set: (req, _user, provider, key) =>
      answered(ask('PUT', `ai-keys/${provider}`, ticket(req), { key })),
    remove: async (req, _user, provider) => {
      await answered(ask('DELETE', `ai-keys/${provider}`, ticket(req)));
    },
  };
}

export function doorChatUsage(ask: AskDoor): ChatUsage {
  return {
    add: async (req, _user, entry) => {
      await answered(ask('POST', 'ai-usage', ticket(req), { entry }));
    },
    report: (req) => answered(ask('GET', 'ai-usage', ticket(req))),
    purgeExpired: () => 0,
  };
}

export function peopleChatKeys(keys: SealedKeyStore, idPrefix: string): ChatKeys {
  const owner = (user: SessionUser) => personId(idPrefix, user.id);
  return {
    info: async (_req, user) => keys.info(owner(user)),
    get: async (_req, user, provider) => keys.get(owner(user), provider),
    set: async (_req, user, provider, key, now) => keys.set(owner(user), provider, key, now),
    remove: async (_req, user, provider) => keys.remove(owner(user), provider),
  };
}

export function peopleChatUsage(
  data: PersonChatData,
  wikiKey: string,
  idPrefix: string,
): ChatUsage {
  const owner = (user: SessionUser) => personId(idPrefix, user.id);
  return {
    add: async (_req, user, entry) => data.addUsage(owner(user), wikiKey, entry, new Date()),
    report: async (_req, user) => {
      const answer = data.answer({
        person: owner(user),
        login: user.login,
        wikiKey,
        method: 'GET',
        path: 'ai-usage',
        body: {},
      });
      return answer?.body as UsageReport;
    },
    purgeExpired: (now) => data.purgeUsage(now),
  };
}
