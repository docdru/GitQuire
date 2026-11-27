import { FrontDoorConfigError } from './settings.ts';

type Env = Readonly<Record<string, string | undefined>>;

interface OldSetting {
  name: string;
  instead: (key: string) => string;
}

const removed =
  (why: string) =>
  (_key: string): string =>
    `removed: ${why}`;
const perHost =
  (suffix: string) =>
  (key: string): string =>
    `GITQUIRE_HOST_${key}_${suffix}`;

const OLD_SETTINGS: readonly OldSetting[] = [
  { name: 'GITQUIRE_REPO', instead: removed('wikis are added in the app (Add a wiki)') },
  { name: 'GITHUB_APP_CLIENT_ID', instead: () => 'GITQUIRE_HOST_GITHUB_CLIENT_ID' },
  { name: 'GITHUB_APP_CLIENT_SECRET', instead: () => 'GITQUIRE_HOST_GITHUB_CLIENT_SECRET' },
  {
    name: 'GITHUB_APP_CLIENT_SECRET_FILE',
    instead: () => 'GITQUIRE_HOST_GITHUB_CLIENT_SECRET_FILE',
  },
  { name: 'GITHUB_APP_ID', instead: () => 'GITQUIRE_HOST_GITHUB_APP_ID' },
  { name: 'GITHUB_APP_PRIVATE_KEY', instead: () => 'GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY' },
  {
    name: 'GITHUB_APP_PRIVATE_KEY_FILE',
    instead: () => 'GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY_FILE',
  },
  { name: 'GITQUIRE_GITHUB_WEB_URL', instead: () => 'GITQUIRE_HOST_GITHUB_URL' },
  { name: 'GITQUIRE_GITHUB_API_URL', instead: () => 'GITQUIRE_HOST_GITHUB_API_URL' },
  {
    name: 'GITQUIRE_HOST',
    instead: (key) => `list "${key.toLowerCase()}" in GITQUIRE_HOSTS`,
  },
  { name: 'GITQUIRE_HOST_URL', instead: perHost('URL') },
  { name: 'GITQUIRE_HOST_API_URL', instead: perHost('API_URL') },
  { name: 'GITQUIRE_HOST_CLIENT_ID', instead: perHost('CLIENT_ID') },
  { name: 'GITQUIRE_HOST_CLIENT_SECRET', instead: perHost('CLIENT_SECRET') },
  { name: 'GITQUIRE_HOST_CLIENT_SECRET_FILE', instead: perHost('CLIENT_SECRET_FILE') },
  { name: 'GITQUIRE_HOST_TOKEN', instead: perHost('TOKEN') },
  { name: 'GITQUIRE_HOST_TOKEN_FILE', instead: perHost('TOKEN_FILE') },
  {
    name: 'GITQUIRE_HOST_REPO_TOKEN',
    instead: removed("a server administrator enters each wiki's token in the app"),
  },
  {
    name: 'GITQUIRE_HOST_REPO_TOKEN_FILE',
    instead: removed("a server administrator enters each wiki's token in the app"),
  },
  { name: 'GITQUIRE_HOST_KEY', instead: removed('the key is the name listed in GITQUIRE_HOSTS') },
  { name: 'GITQUIRE_HOST_LABEL', instead: perHost('LABEL') },
  { name: 'GITQUIRE_ADMINS', instead: perHost('ADMINS') },
  { name: 'GITQUIRE_ALLOWED_OWNERS', instead: perHost('ALLOWED_OWNERS') },
  { name: 'GITQUIRE_COMMIT_EMAIL_FORMAT', instead: perHost('COMMIT_EMAIL_FORMAT') },
  {
    name: 'GITQUIRE_ALLOWED_USERS',
    instead: removed('access is write access to the repository on its host'),
  },
  {
    name: 'GITQUIRE_MCP_TOKEN',
    instead: removed('each person makes agent tokens or connects a connector'),
  },
  {
    name: 'GITQUIRE_MCP_TOKEN_FILE',
    instead: removed('each person makes agent tokens or connects a connector'),
  },
  { name: 'GITQUIRE_AUTH', instead: removed('sign-in is always on') },
  { name: 'GITQUIRE_BRANCH', instead: removed("a wiki follows its repository's default branch") },
  { name: 'GITQUIRE_SYNC_MODE', instead: removed('every wiki syncs both ways') },
  { name: 'GITQUIRE_AUTO_SYNC_MODE', instead: removed('every wiki syncs both ways') },
];

function hostKeyHint(env: Env): string {
  const kind = env.GITQUIRE_HOST?.trim().toLowerCase();
  return kind === undefined || kind === '' ? 'GITHUB' : kind.toUpperCase().replaceAll('-', '_');
}

export function oldSettingsIn(env: Env): string[] {
  const key = hostKeyHint(env);
  return OLD_SETTINGS.filter((old) => env[old.name] !== undefined).map(
    (old) => `${old.name} → ${old.instead(key)}`,
  );
}

export function refuseOldSettings(env: Env): void {
  const found = oldSettingsIn(env);
  if (found.length === 0) return;
  throw new FrontDoorConfigError(
    `These settings are no longer read. Rename or remove each of them, then start again (DEPLOY.md, "Environment variable reference"):\n${found.map((line) => `  ${line}`).join('\n')}`,
  );
}

export function refuseTrailingComments(env: Env): void {
  const names = Object.entries(env)
    .filter(
      ([name, value]) =>
        name.startsWith('GITQUIRE_') &&
        !name.startsWith('GITQUIRE_TEST_') &&
        value !== undefined &&
        /\s#/.test(value),
    )
    .map(([name]) => name)
    .sort();
  if (names.length === 0) return;
  throw new FrontDoorConfigError(
    `The values of ${names.join(', ')} end in a comment ("… # …"). docker run --env-file passes such a comment as part of the value. Put comments on a line of their own.`,
  );
}
