import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HostListError, type HostSettings, hostKeys, hostList } from './hosts.ts';
import { refuseOldSettings, refuseTrailingComments } from './old-settings.ts';

type Env = Readonly<Record<string, string | undefined>>;

export class FrontDoorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontDoorConfigError';
  }
}

export class FrontDoorSetupNeeded extends FrontDoorConfigError {
  readonly missing: readonly string[];
  readonly hostKeys: readonly string[];

  constructor(missing: readonly string[], hostKeys: readonly string[]) {
    super(`GitQuire needs these settings: ${missing.join(', ')}.`);
    this.name = 'FrontDoorSetupNeeded';
    this.missing = missing;
    this.hostKeys = hostKeys;
  }
}

export interface FrontDoorSettings {
  dataDir: string;
  externalUrl: URL;
  sessionSecret: string;
  sessionMaxAgeSeconds: number;
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

export function resolveFrontDoorSettings(
  env: Env,
  dataDir: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): FrontDoorSettings {
  refuseOldSettings(env);
  refuseTrailingComments(env);
  let listed: ReturnType<typeof hostList>;
  try {
    listed = hostList(env, readFile);
  } catch (err) {
    if (err instanceof HostListError) throw new FrontDoorConfigError(err.message);
    throw err;
  }
  const sessionSecret = nonEmpty(env.GITQUIRE_SESSION_SECRET);
  const externalRaw = nonEmpty(env.GITQUIRE_EXTERNAL_URL);
  const missing: string[] = [];
  if (externalRaw === undefined) missing.push('GITQUIRE_EXTERNAL_URL');
  if (sessionSecret === undefined) missing.push('GITQUIRE_SESSION_SECRET');
  if (hostKeys(env).length === 0) missing.push('GITQUIRE_HOSTS');
  missing.push(...listed.missing);
  if (sessionSecret !== undefined && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new FrontDoorConfigError(
      `GITQUIRE_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. Generate one with: openssl rand -hex 32`,
    );
  }
  let externalUrl: URL | undefined;
  if (externalRaw !== undefined) {
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
        `GITQUIRE_EXTERNAL_URL must be the server's root address (the wikis live under /w/); got the path ${externalUrl.pathname}.`,
      );
    }
  }
  if (missing.length > 0 || externalUrl === undefined || sessionSecret === undefined) {
    throw new FrontDoorSetupNeeded(missing, hostKeys(env));
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
  return {
    dataDir: resolve(dataDir),
    externalUrl,
    sessionSecret,
    sessionMaxAgeSeconds: Math.round(sessionDays * 24 * 60 * 60),
    agentTokenDays,
    mcpConnectors: ['1', 'on', 'true', 'yes'].includes(
      nonEmpty(env.GITQUIRE_MCP_CONNECTORS)?.toLowerCase() ?? '',
    ),
    accessCheckMs: Math.round(accessCheckSeconds * 1000),
    wikiIdleMs: Math.round(wikiIdleMinutes * 60 * 1000),
    hosts: listed.hosts,
  };
}
