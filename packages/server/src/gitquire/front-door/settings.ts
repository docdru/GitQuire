import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loginSet, parseGitHubRepo } from '../github-auth-config.ts';
import { hostNamesFromEnv, parseHostKind } from '../host/names.ts';
import type { HostKind, HostRepo } from '../host/types.ts';
import { HostListError, type HostSettings, hostList } from './hosts.ts';

type Env = Readonly<Record<string, string | undefined>>;

export class FrontDoorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontDoorConfigError';
  }
}

export interface FrontDoorSettings {
  host: HostKind;
  dataDir: string;
  externalUrl: URL;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  sessionMaxAgeSeconds: number;
  webUrl: string;
  apiUrl: string;
  defaultWiki: HostRepo | undefined;
  allowedOwners: ReadonlySet<string>;
  serverAdmins: ReadonlySet<string>;
  githubApp: { appId: string; privateKeyPem: string } | undefined;
  forgejoBotToken: string | undefined;
  agentTokenDays: number;
  mcpConnectors: boolean;
  accessCheckMs: number;
  wikiIdleMs: number;
  hosts: readonly HostSettings[];
}

const MIN_SESSION_SECRET_LENGTH = 32;
const DEFAULT_SESSION_DAYS = 7;
const DEFAULT_AGENT_TOKEN_DAYS = 90;
const DEFAULT_ACCESS_CHECK_SECONDS = 300;
const DEFAULT_WIKI_IDLE_MINUTES = 30;

function numberSetting(
  env: Env,
  name: string,
  fallback: number,
  range: { min: number; max: number; what: string },
): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new FrontDoorConfigError(`${name} must be ${range.what}, got "${raw}".`);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function wikisModeFromEnv(env: Env): boolean {
  const value = nonEmpty(env.GITQUIRE_WIKIS)?.toLowerCase();
  if (value === undefined || ['0', 'off', 'false', 'no'].includes(value)) return false;
  if (['1', 'on', 'true', 'yes'].includes(value)) return true;
  throw new FrontDoorConfigError(`GITQUIRE_WIKIS must be on or off, got "${value}".`);
}

function secretFrom(
  env: Env,
  name: string,
  readFile: (path: string) => string,
): string | undefined {
  const inline = nonEmpty(env[name]);
  if (inline !== undefined) return inline;
  const file = nonEmpty(env[`${name}_FILE`]);
  if (file === undefined) return undefined;
  try {
    return nonEmpty(readFile(file));
  } catch (err) {
    throw new FrontDoorConfigError(
      `Could not read ${name}_FILE (${file}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function refuseSingleWikiSettings(env: Env): void {
  const refused = ['GITQUIRE_ALLOWED_USERS', 'GITQUIRE_MCP_TOKEN'].filter(
    (name) => nonEmpty(env[name]) !== undefined,
  );
  if (refused.length > 0) {
    throw new FrontDoorConfigError(
      `${refused.join(' and ')} cannot be used with GITQUIRE_WIKIS=on: ${refused.length === 1 ? 'it skips' : 'they skip'} the check of who may write to each wiki's repository and would open every wiki. Remove ${refused.length === 1 ? 'it' : 'them'}; with several wikis the Git host decides who may open each wiki.`,
    );
  }
}

function allowedOwnersFrom(env: Env, defaultWiki: HostRepo | undefined): ReadonlySet<string> {
  const listed = loginSet(env.GITQUIRE_ALLOWED_OWNERS);
  if (listed.size > 0) return listed;
  if (defaultWiki !== undefined) return new Set([defaultWiki.owner.toLowerCase()]);
  throw new FrontDoorConfigError(
    'GITQUIRE_WIKIS=on needs GITQUIRE_ALLOWED_OWNERS (the users or organisations whose repositories may become wikis) or GITQUIRE_REPO (then only its owner is allowed). Set one of them.',
  );
}

function hostAddresses(env: Env, host: HostKind): { web: string; api: string } {
  if (host === 'github') {
    return {
      web: stripTrailingSlash(nonEmpty(env.GITQUIRE_GITHUB_WEB_URL) ?? 'https://github.com'),
      api: stripTrailingSlash(nonEmpty(env.GITQUIRE_GITHUB_API_URL) ?? 'https://api.github.com'),
    };
  }
  const web = nonEmpty(env.GITQUIRE_HOST_URL);
  if (web === undefined) {
    throw new FrontDoorConfigError(
      'GITQUIRE_HOST=forgejo needs GITQUIRE_HOST_URL, the address of the Forgejo server.',
    );
  }
  let url: URL;
  try {
    url = new URL(web);
  } catch {
    throw new FrontDoorConfigError(`GITQUIRE_HOST_URL is not a valid URL: "${web}".`);
  }
  if (url.protocol !== 'https:') {
    throw new FrontDoorConfigError(
      "GITQUIRE_HOST_URL must start with https://: Git only sends GitQuire's token over https.",
    );
  }
  const base = stripTrailingSlash(web);
  return {
    web: base,
    api: stripTrailingSlash(nonEmpty(env.GITQUIRE_HOST_API_URL) ?? `${base}/api/v1`),
  };
}

export function resolveFrontDoorSettings(
  env: Env,
  dataDir: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): FrontDoorSettings {
  refuseSingleWikiSettings(env);
  const host = parseHostKind(env);
  const defaultWiki = parseGitHubRepo(env.GITQUIRE_REPO);
  const allowedOwners = allowedOwnersFrom(env, defaultWiki);
  const clientIdVar = host === 'forgejo' ? 'GITQUIRE_HOST_CLIENT_ID' : 'GITHUB_APP_CLIENT_ID';
  const clientSecretVar =
    host === 'forgejo' ? 'GITQUIRE_HOST_CLIENT_SECRET' : 'GITHUB_APP_CLIENT_SECRET';
  const clientId = nonEmpty(env[clientIdVar]);
  const clientSecret = nonEmpty(env[clientSecretVar]);
  const sessionSecret = nonEmpty(env.GITQUIRE_SESSION_SECRET);
  const externalRaw = nonEmpty(env.GITQUIRE_EXTERNAL_URL);
  const missing: string[] = [];
  if (clientId === undefined) missing.push(clientIdVar);
  if (clientSecret === undefined) missing.push(clientSecretVar);
  if (sessionSecret === undefined) missing.push('GITQUIRE_SESSION_SECRET');
  if (externalRaw === undefined) missing.push('GITQUIRE_EXTERNAL_URL');

  let githubApp: FrontDoorSettings['githubApp'];
  let forgejoBotToken: string | undefined;
  if (host === 'github') {
    const appId = nonEmpty(env.GITHUB_APP_ID);
    const key = nonEmpty(env.GITHUB_APP_PRIVATE_KEY)?.replace(/\\n/g, '\n');
    const keyFile = nonEmpty(env.GITHUB_APP_PRIVATE_KEY_FILE);
    if (appId === undefined) missing.push('GITHUB_APP_ID');
    if (key === undefined && keyFile === undefined) {
      missing.push('GITHUB_APP_PRIVATE_KEY_FILE (or GITHUB_APP_PRIVATE_KEY)');
    }
    if (appId !== undefined && (key !== undefined || keyFile !== undefined)) {
      let pem: string;
      if (key !== undefined) {
        pem = key;
      } else {
        try {
          pem = readFile(keyFile as string);
        } catch (err) {
          throw new FrontDoorConfigError(
            `Could not read GITHUB_APP_PRIVATE_KEY_FILE (${keyFile}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (!pem.includes('PRIVATE KEY-----')) {
        throw new FrontDoorConfigError(
          'The GitHub App private key is not a PEM file. Download it from the app settings page.',
        );
      }
      githubApp = { appId, privateKeyPem: pem };
    }
  } else {
    forgejoBotToken = secretFrom(env, 'GITQUIRE_HOST_TOKEN', readFile);
    if (forgejoBotToken === undefined) {
      missing.push('GITQUIRE_HOST_TOKEN (or GITQUIRE_HOST_TOKEN_FILE)');
    }
  }

  if (
    missing.length > 0 ||
    clientId === undefined ||
    clientSecret === undefined ||
    sessionSecret === undefined ||
    externalRaw === undefined
  ) {
    throw new FrontDoorConfigError(
      `GITQUIRE_WIKIS=on needs these settings: ${missing.join(', ')}.`,
    );
  }
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new FrontDoorConfigError(
      `GITQUIRE_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. Generate one with: openssl rand -hex 32`,
    );
  }
  let externalUrl: URL;
  try {
    externalUrl = new URL(externalRaw);
  } catch {
    throw new FrontDoorConfigError(`GITQUIRE_EXTERNAL_URL is not a valid URL: "${externalRaw}".`);
  }
  if (externalUrl.protocol !== 'https:' && externalUrl.protocol !== 'http:') {
    throw new FrontDoorConfigError('GITQUIRE_EXTERNAL_URL must start with https:// or http://.');
  }
  if (externalUrl.pathname !== '/' && externalUrl.pathname !== '') {
    throw new FrontDoorConfigError(
      `With GITQUIRE_WIKIS=on, GITQUIRE_EXTERNAL_URL must be the server's root address (the wikis live under /w/); got the path ${externalUrl.pathname}.`,
    );
  }
  const sessionDaysRaw = nonEmpty(env.GITQUIRE_SESSION_DAYS);
  const sessionDays = sessionDaysRaw === undefined ? DEFAULT_SESSION_DAYS : Number(sessionDaysRaw);
  if (!Number.isFinite(sessionDays) || sessionDays <= 0) {
    throw new FrontDoorConfigError(
      `GITQUIRE_SESSION_DAYS must be a positive number, got "${sessionDaysRaw}".`,
    );
  }
  const agentDaysRaw = nonEmpty(env.GITQUIRE_AGENT_TOKEN_DAYS);
  const agentTokenDays =
    agentDaysRaw === undefined ? DEFAULT_AGENT_TOKEN_DAYS : Number(agentDaysRaw);
  if (!Number.isFinite(agentTokenDays) || agentTokenDays <= 0 || agentTokenDays > 3650) {
    throw new FrontDoorConfigError(
      `GITQUIRE_AGENT_TOKEN_DAYS must be a number of days between 1 and 3650, got "${agentDaysRaw}".`,
    );
  }
  const accessCheckSeconds = numberSetting(
    env,
    'GITQUIRE_ACCESS_CHECK_SECONDS',
    DEFAULT_ACCESS_CHECK_SECONDS,
    { min: 1, max: 3600, what: 'a number of seconds between 1 and 3600' },
  );
  const wikiIdleMinutes = numberSetting(
    env,
    'GITQUIRE_WIKI_IDLE_MINUTES',
    DEFAULT_WIKI_IDLE_MINUTES,
    {
      min: 0.01,
      max: 1440,
      what: 'a number of minutes between 0.01 and 1440',
    },
  );
  const addresses = hostAddresses(env, host);
  const primary: HostSettings = {
    key: host,
    kind: host,
    label: host === 'github' ? 'GitHub' : 'Forgejo',
    primary: true,
    webUrl: addresses.web,
    apiUrl: addresses.api,
    clientId,
    clientSecret,
    githubApp,
    forgejoBotToken,
    allowedOwners,
    serverAdmins: loginSet(env.GITQUIRE_ADMINS),
    commitEmailFormat: nonEmpty(env.GITQUIRE_COMMIT_EMAIL_FORMAT),
    names: hostNamesFromEnv(env),
  };
  let hosts: readonly HostSettings[];
  try {
    hosts = hostList(env, primary, readFile);
  } catch (err) {
    if (err instanceof HostListError) throw new FrontDoorConfigError(err.message);
    throw err;
  }
  return {
    host,
    dataDir: resolve(dataDir),
    externalUrl,
    clientId,
    clientSecret,
    sessionSecret,
    sessionMaxAgeSeconds: Math.round(sessionDays * 24 * 60 * 60),
    webUrl: addresses.web,
    apiUrl: addresses.api,
    defaultWiki,
    allowedOwners,
    serverAdmins: primary.serverAdmins,
    githubApp,
    forgejoBotToken,
    agentTokenDays,
    mcpConnectors: ['1', 'on', 'true', 'yes'].includes(
      nonEmpty(env.GITQUIRE_MCP_CONNECTORS)?.toLowerCase() ?? '',
    ),
    accessCheckMs: Math.round(accessCheckSeconds * 1000),
    wikiIdleMs: Math.round(wikiIdleMinutes * 60 * 1000),
    hosts,
  };
}
