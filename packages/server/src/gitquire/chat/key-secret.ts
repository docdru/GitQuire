import { createHmac } from 'node:crypto';
import { behindFrontDoorFromEnv } from '../request-person.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const CHAT_KEY_SECRET_ENV = 'GITQUIRE_CHAT_KEY_SECRET';
const MIN_SECRET_LENGTH = 32;

export function deriveChatKeySecret(sessionSecret: string, wikiKey: string): string {
  return createHmac('sha256', sessionSecret)
    .update(`gitquire-ai-chat-keys:${wikiKey}`, 'utf8')
    .digest('hex');
}

export function chatKeySecretFromEnv(env: Env): string | undefined {
  const raw = behindFrontDoorFromEnv(env) ? env[CHAT_KEY_SECRET_ENV] : env.GITQUIRE_SESSION_SECRET;
  const secret = raw?.trim() ?? '';
  return secret.length < MIN_SECRET_LENGTH ? undefined : secret;
}

export function derivePeopleKeySecret(sessionSecret: string): string {
  return createHmac('sha256', sessionSecret)
    .update('gitquire-ai-chat-keys:people', 'utf8')
    .digest('hex');
}
