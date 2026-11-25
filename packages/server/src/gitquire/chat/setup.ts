import type { IncomingMessage } from 'node:http';
import { basename } from 'node:path';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import { DOOR_TOKEN_SOCKET_ENV } from '../door-token.ts';
import { parseGitHubRepo } from '../github-auth-config.ts';
import { doorAsker } from '../people/door-client.ts';
import { behindFrontDoorFromEnv } from '../request-person.ts';
import { createChatHistoryStore } from './history.ts';
import { chatKeySecretFromEnv } from './key-secret.ts';
import { createChatKeyStore } from './key-store.ts';
import {
  type ChatKeys,
  type ChatUsage,
  doorChatKeys,
  doorChatUsage,
  localChatKeys,
  localChatUsage,
} from './person-data.ts';
import { createChatProviders } from './providers.ts';
import { type ChatRoutes, createChatRoutes } from './routes.ts';
import { createChatUsageStore } from './usage.ts';
import { createLoopbackWikiTools } from './wiki-tools.ts';

type Env = Readonly<Record<string, string | undefined>>;

function isOff(value: string | undefined): boolean {
  return ['0', 'off', 'false', 'no'].includes(value?.trim().toLowerCase() ?? '');
}

function baseUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (raw === undefined || raw === '') return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Provider base URLs must use http(s): ${raw}`);
  }
  return url.toString().replace(/\/+$/, '');
}

function wikiNameFrom(env: Env, projectDir: string): string {
  try {
    const repo = parseGitHubRepo(env.GITQUIRE_REPO);
    if (repo !== undefined) return `${repo.owner}/${repo.name}`;
  } catch {}
  return basename(projectDir) || 'wiki';
}

export function chatStoresFromEnv(
  env: Env,
  projectDir: string,
): { keys: ChatKeys; usage: ChatUsage } | undefined {
  const socket = env[DOOR_TOKEN_SOCKET_ENV]?.trim() ?? '';
  if (behindFrontDoorFromEnv(env)) {
    if (socket === '') return undefined;
    const ask = doorAsker(socket);
    return { keys: doorChatKeys(ask), usage: doorChatUsage(ask) };
  }
  const secret = chatKeySecretFromEnv(env);
  if (secret === undefined) return undefined;
  return {
    keys: localChatKeys(createChatKeyStore(projectDir, secret)),
    usage: localChatUsage(createChatUsageStore(projectDir)),
  };
}

export function createChatFromEnv(
  env: Env,
  options: {
    projectDir: string;
    sessionUser: (req: IncomingMessage) => SessionUser | undefined;
    log: GateLogger;
    ownPort?: () => number | undefined;
  },
): ChatRoutes | undefined {
  if (isOff(env.GITQUIRE_AI_CHAT)) return undefined;
  const stores = chatStoresFromEnv(env, options.projectDir);
  if (stores === undefined) return undefined;
  const wikiName = wikiNameFrom(env, options.projectDir);
  const anthropic = baseUrl(env.GITQUIRE_ANTHROPIC_BASE_URL);
  const mistral = baseUrl(env.GITQUIRE_MISTRAL_BASE_URL);
  const endpoints = {
    ...(anthropic === undefined ? {} : { anthropic }),
    ...(mistral === undefined ? {} : { mistral }),
  };
  return createChatRoutes({
    keys: stores.keys,
    history: createChatHistoryStore(options.projectDir),
    usage: stores.usage,
    providers: createChatProviders({ endpoints }),
    openTools: createLoopbackWikiTools({ clientName: 'GitQuire AI chat', version: '1' }),
    sessionUser: options.sessionUser,
    wikiName: () => wikiName,
    log: options.log,
    ownPort: options.ownPort,
  });
}
