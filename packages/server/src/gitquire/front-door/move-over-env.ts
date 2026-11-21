import { readFileSync } from 'node:fs';
import { hostNamesFromEnv, setHostNames } from '../host/names.ts';
import { createForgejoTokenScopeCheck } from './forgejo-token-check.ts';
import {
  adoptSingleWiki,
  type MoveOverOptions,
  type MoveOverReport,
  type RepoTokenCheck,
  unadoptWiki,
} from './move-over.ts';
import { FrontDoorConfigError, resolveFrontDoorSettings } from './settings.ts';
import { doorHostFor } from './start.ts';

type Env = Readonly<Record<string, string | undefined>>;

function repoTokenFromEnv(env: Env): string | undefined {
  const inline = env.GITQUIRE_HOST_REPO_TOKEN?.trim();
  if (inline !== undefined && inline !== '') return inline;
  const file = env.GITQUIRE_HOST_REPO_TOKEN_FILE?.trim();
  if (file === undefined || file === '') return undefined;
  try {
    const token = readFileSync(file, 'utf8').trim();
    return token === '' ? undefined : token;
  } catch (err) {
    throw new FrontDoorConfigError(
      `Could not read GITQUIRE_HOST_REPO_TOKEN_FILE (${file}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function moveOverFromEnv(
  direction: 'adopt' | 'unadopt',
  dataDir: string,
  env: Env,
  running: (dir: string) => string | undefined,
  options: MoveOverOptions,
): Promise<MoveOverReport> {
  setHostNames(hostNamesFromEnv(env));
  const settings = resolveFrontDoorSettings(env, dataDir);
  if (direction === 'unadopt') return unadoptWiki({ settings, env, running }, options);
  const repoToken = settings.host === 'forgejo' ? repoTokenFromEnv(env) : undefined;
  if (repoToken !== undefined && repoToken === settings.forgejoBotToken) {
    throw new FrontDoorConfigError(
      "GITQUIRE_HOST_REPO_TOKEN is the bot's unlimited token. A wiki's token must be limited to its repository.",
    );
  }
  const checkRepoToken: RepoTokenCheck = async (repo, token) => {
    const trial = doorHostFor(settings, () => token);
    const health = await trial.health(repo);
    if (health !== 'ok') return health;
    const scope = await createForgejoTokenScopeCheck({
      apiUrl: settings.apiUrl,
      botToken: () => settings.forgejoBotToken,
    })(repo, token);
    return scope === 'limited' ? 'ok' : scope;
  };
  return adoptSingleWiki(
    {
      settings,
      env,
      running,
      host: doorHostFor(settings, () => undefined),
      repoToken,
      checkRepoToken,
    },
    options,
  );
}
