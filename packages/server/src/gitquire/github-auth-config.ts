import { parseHostKind } from './host/names.ts';
import type { HostKind } from './host/types.ts';

export interface GitHubRepoRef {
  owner: string;
  name: string;
}

export interface GitHubAuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  externalUrl: URL;
  repo: GitHubRepoRef | undefined;
  allowedUsers: ReadonlySet<string>;
  admins: ReadonlySet<string>;
  mcpToken: string | undefined;
  agentTokenDays: number;
  mcpConnectors: boolean;
  aiChat: boolean;
  sessionMaxAgeSeconds: number;
  githubWebUrl: string;
  githubApiUrl: string;
}

export class GitHubAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthConfigError';
  }
}

const MIN_SESSION_SECRET_LENGTH = 32;
const DEFAULT_SESSION_DAYS = 7;
const DEFAULT_AGENT_TOKEN_DAYS = 90;
const REPO_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function isOn(value: string | undefined): boolean {
  return ['1', 'on', 'true', 'yes'].includes(nonEmpty(value)?.toLowerCase() ?? '');
}

function isOff(value: string | undefined): boolean {
  return ['0', 'off', 'false', 'no'].includes(nonEmpty(value)?.toLowerCase() ?? '');
}

function loginSet(value: string | undefined): ReadonlySet<string> {
  const logins = (value ?? '')
    .split(/[\s,]+/)
    .map((login) => login.trim().replace(/^@/, '').toLowerCase())
    .filter((login) => login !== '');
  return new Set(logins);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function parseGitHubRepo(value: string | undefined): GitHubRepoRef | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) return undefined;
  const match = REPO_RE.exec(raw.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''));
  if (match === null) {
    throw new GitHubAuthConfigError(
      `GITQUIRE_REPO must look like owner/name or https://github.com/owner/name, got "${raw}".`,
    );
  }
  return { owner: match[1], name: match[2] };
}

interface SignInNames {
  host: HostKind;
  clientIdVar: string;
  clientSecretVar: string;
}

function signInNames(env: Readonly<Record<string, string | undefined>>): SignInNames {
  return parseHostKind(env) === 'forgejo'
    ? {
        host: 'forgejo',
        clientIdVar: 'GITQUIRE_HOST_CLIENT_ID',
        clientSecretVar: 'GITQUIRE_HOST_CLIENT_SECRET',
      }
    : {
        host: 'github',
        clientIdVar: 'GITHUB_APP_CLIENT_ID',
        clientSecretVar: 'GITHUB_APP_CLIENT_SECRET',
      };
}

function isGitHubAuthRequested(
  env: Readonly<Record<string, string | undefined>>,
  names: SignInNames,
): boolean {
  const mode = nonEmpty(env.GITQUIRE_AUTH)?.toLowerCase();
  if (mode === 'off' || mode === 'none') return false;
  return mode === names.host || nonEmpty(env[names.clientIdVar]) !== undefined;
}

function hostAddresses(
  env: Readonly<Record<string, string | undefined>>,
  host: HostKind,
): { web: string; api: string } {
  if (host === 'github') {
    return {
      web: stripTrailingSlash(nonEmpty(env.GITQUIRE_GITHUB_WEB_URL) ?? 'https://github.com'),
      api: stripTrailingSlash(nonEmpty(env.GITQUIRE_GITHUB_API_URL) ?? 'https://api.github.com'),
    };
  }
  const web = nonEmpty(env.GITQUIRE_HOST_URL);
  if (web === undefined) {
    throw new GitHubAuthConfigError(
      'GITQUIRE_HOST=forgejo needs GITQUIRE_HOST_URL, the address of the Forgejo server.',
    );
  }
  const base = stripTrailingSlash(web);
  return {
    web: base,
    api: stripTrailingSlash(nonEmpty(env.GITQUIRE_HOST_API_URL) ?? `${base}/api/v1`),
  };
}

export function resolveGitHubAuthConfig(
  env: Readonly<Record<string, string | undefined>>,
  runtime: { externalUrl: string | undefined },
): GitHubAuthConfig | undefined {
  const names = signInNames(env);
  if (!isGitHubAuthRequested(env, names)) return undefined;

  const clientId = nonEmpty(env[names.clientIdVar]);
  const clientSecret = nonEmpty(env[names.clientSecretVar]);
  const sessionSecret = nonEmpty(env.GITQUIRE_SESSION_SECRET);
  const externalUrlRaw = nonEmpty(runtime.externalUrl) ?? nonEmpty(env.GITQUIRE_EXTERNAL_URL);

  const missing: string[] = [];
  if (clientId === undefined) missing.push(names.clientIdVar);
  if (clientSecret === undefined) missing.push(names.clientSecretVar);
  if (sessionSecret === undefined) missing.push('GITQUIRE_SESSION_SECRET');
  if (externalUrlRaw === undefined) missing.push('GITQUIRE_EXTERNAL_URL');
  if (
    clientId === undefined ||
    clientSecret === undefined ||
    sessionSecret === undefined ||
    externalUrlRaw === undefined
  ) {
    throw new GitHubAuthConfigError(
      `${names.host === 'github' ? 'GitHub' : 'Forgejo'} sign-in is enabled but these settings are missing: ${missing.join(', ')}.`,
    );
  }

  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new GitHubAuthConfigError(
      `GITQUIRE_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. Generate one with: openssl rand -hex 32`,
    );
  }

  let externalUrl: URL;
  try {
    externalUrl = new URL(externalUrlRaw);
  } catch {
    throw new GitHubAuthConfigError(
      `GITQUIRE_EXTERNAL_URL is not a valid URL: "${externalUrlRaw}".`,
    );
  }
  if (externalUrl.protocol !== 'https:' && externalUrl.protocol !== 'http:') {
    throw new GitHubAuthConfigError('GITQUIRE_EXTERNAL_URL must start with https:// or http://.');
  }

  const repo = parseGitHubRepo(env.GITQUIRE_REPO);
  const allowedUsers = loginSet(env.GITQUIRE_ALLOWED_USERS);
  if (repo === undefined && allowedUsers.size === 0) {
    throw new GitHubAuthConfigError(
      names.host === 'github'
        ? 'GitHub sign-in needs GITQUIRE_REPO (people with write access may sign in) or GITQUIRE_ALLOWED_USERS (a list of GitHub logins).'
        : 'Forgejo sign-in needs GITQUIRE_REPO (people with write access may sign in) or GITQUIRE_ALLOWED_USERS (a list of Forgejo logins).',
    );
  }

  const sessionDaysRaw = nonEmpty(env.GITQUIRE_SESSION_DAYS);
  const sessionDays = sessionDaysRaw === undefined ? DEFAULT_SESSION_DAYS : Number(sessionDaysRaw);
  if (!Number.isFinite(sessionDays) || sessionDays <= 0) {
    throw new GitHubAuthConfigError(
      `GITQUIRE_SESSION_DAYS must be a positive number, got "${sessionDaysRaw}".`,
    );
  }

  const agentDaysRaw = nonEmpty(env.GITQUIRE_AGENT_TOKEN_DAYS);
  const agentTokenDays =
    agentDaysRaw === undefined ? DEFAULT_AGENT_TOKEN_DAYS : Number(agentDaysRaw);
  if (!Number.isFinite(agentTokenDays) || agentTokenDays <= 0 || agentTokenDays > 3650) {
    throw new GitHubAuthConfigError(
      `GITQUIRE_AGENT_TOKEN_DAYS must be a number of days between 1 and 3650, got "${agentDaysRaw}".`,
    );
  }

  const addresses = hostAddresses(env, names.host);
  return {
    clientId,
    clientSecret,
    sessionSecret,
    externalUrl,
    repo,
    allowedUsers,
    admins: loginSet(env.GITQUIRE_ADMINS),
    mcpToken: nonEmpty(env.GITQUIRE_MCP_TOKEN),
    agentTokenDays,
    mcpConnectors: isOn(env.GITQUIRE_MCP_CONNECTORS),
    aiChat: !isOff(env.GITQUIRE_AI_CHAT),
    sessionMaxAgeSeconds: Math.round(sessionDays * 24 * 60 * 60),
    githubWebUrl: addresses.web,
    githubApiUrl: addresses.api,
  };
}
