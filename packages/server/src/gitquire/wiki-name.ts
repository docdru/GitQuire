import { behindFrontDoorFromEnv } from './request-person.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const WIKI_NAME_ENV = 'GITQUIRE_WIKI_NAME';

export function wikiNameFromEnv(env: Env): string | undefined {
  if (!behindFrontDoorFromEnv(env)) return undefined;
  const named = env[WIKI_NAME_ENV]?.trim() ?? '';
  const parts = named.split('/');
  if (
    parts.length === 3 &&
    /^[a-z][a-z0-9-]*$/.test(parts[0] as string) &&
    parts.slice(1).every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== '.' && part !== '..')
  ) {
    return named;
  }
  const repo = env.GITQUIRE_REPO?.trim() ?? '';
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : undefined;
}
