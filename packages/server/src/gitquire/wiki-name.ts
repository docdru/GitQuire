import { behindFrontDoorFromEnv } from './request-person.ts';

type Env = Readonly<Record<string, string | undefined>>;

export function wikiNameFromEnv(env: Env): string | undefined {
  if (!behindFrontDoorFromEnv(env)) return undefined;
  const repo = env.GITQUIRE_REPO?.trim() ?? '';
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : undefined;
}
