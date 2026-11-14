import type { IncomingMessage } from 'node:http';
import { basename } from 'node:path';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import { parseGitHubRepo } from '../github-auth-config.ts';
import { createChatHistoryStore } from './history.ts';
import { createChatKeyStore } from './key-store.ts';
import { createChatProviders } from './providers.ts';
import { type ChatRoutes, createChatRoutes } from './routes.ts';
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

export function createChatFromEnv(
  env: Env,
  options: {
    projectDir: string;
    sessionUser: (req: IncomingMessage) => SessionUser | undefined;
    log: GateLogger;
  },
): ChatRoutes | undefined {
  if (isOff(env.GITQUIRE_AI_CHAT)) return undefined;
  const secret = env.GITQUIRE_SESSION_SECRET?.trim() ?? '';
  if (secret.length < 32) return undefined;
  const wikiName = wikiNameFrom(env, options.projectDir);
  const anthropic = baseUrl(env.GITQUIRE_ANTHROPIC_BASE_URL);
  const mistral = baseUrl(env.GITQUIRE_MISTRAL_BASE_URL);
  const endpoints = {
    ...(anthropic === undefined ? {} : { anthropic }),
    ...(mistral === undefined ? {} : { mistral }),
  };
  return createChatRoutes({
    keys: createChatKeyStore(options.projectDir, secret),
    history: createChatHistoryStore(options.projectDir),
    providers: createChatProviders({ endpoints }),
    openTools: createLoopbackWikiTools({ clientName: 'GitQuire AI chat', version: '1' }),
    sessionUser: options.sessionUser,
    wikiName: () => wikiName,
    log: options.log,
  });
}
