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
const REPO_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
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

export function isGitHubAuthRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  const mode = nonEmpty(env.GITQUIRE_AUTH)?.toLowerCase();
  if (mode === 'off' || mode === 'none') return false;
  return mode === 'github' || nonEmpty(env.GITHUB_APP_CLIENT_ID) !== undefined;
}

export function resolveGitHubAuthConfig(
  env: Readonly<Record<string, string | undefined>>,
  runtime: { externalUrl: string | undefined },
): GitHubAuthConfig | undefined {
  if (!isGitHubAuthRequested(env)) return undefined;

  const clientId = nonEmpty(env.GITHUB_APP_CLIENT_ID);
  const clientSecret = nonEmpty(env.GITHUB_APP_CLIENT_SECRET);
  const sessionSecret = nonEmpty(env.GITQUIRE_SESSION_SECRET);
  const externalUrlRaw = nonEmpty(runtime.externalUrl) ?? nonEmpty(env.OK_EXTERNAL_URL);

  const missing: string[] = [];
  if (clientId === undefined) missing.push('GITHUB_APP_CLIENT_ID');
  if (clientSecret === undefined) missing.push('GITHUB_APP_CLIENT_SECRET');
  if (sessionSecret === undefined) missing.push('GITQUIRE_SESSION_SECRET');
  if (externalUrlRaw === undefined) missing.push('OK_EXTERNAL_URL');
  if (
    clientId === undefined ||
    clientSecret === undefined ||
    sessionSecret === undefined ||
    externalUrlRaw === undefined
  ) {
    throw new GitHubAuthConfigError(
      `GitHub sign-in is enabled but these settings are missing: ${missing.join(', ')}.`,
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
    throw new GitHubAuthConfigError(`OK_EXTERNAL_URL is not a valid URL: "${externalUrlRaw}".`);
  }
  if (externalUrl.protocol !== 'https:' && externalUrl.protocol !== 'http:') {
    throw new GitHubAuthConfigError('OK_EXTERNAL_URL must start with https:// or http://.');
  }

  const repo = parseGitHubRepo(env.GITQUIRE_REPO);
  const allowedUsers = loginSet(env.GITQUIRE_ALLOWED_USERS);
  if (repo === undefined && allowedUsers.size === 0) {
    throw new GitHubAuthConfigError(
      'GitHub sign-in needs GITQUIRE_REPO (people with write access may sign in) or GITQUIRE_ALLOWED_USERS (a list of GitHub logins).',
    );
  }

  const sessionDaysRaw = nonEmpty(env.GITQUIRE_SESSION_DAYS);
  const sessionDays = sessionDaysRaw === undefined ? DEFAULT_SESSION_DAYS : Number(sessionDaysRaw);
  if (!Number.isFinite(sessionDays) || sessionDays <= 0) {
    throw new GitHubAuthConfigError(
      `GITQUIRE_SESSION_DAYS must be a positive number, got "${sessionDaysRaw}".`,
    );
  }

  return {
    clientId,
    clientSecret,
    sessionSecret,
    externalUrl,
    repo,
    allowedUsers,
    admins: loginSet(env.GITQUIRE_ADMINS),
    mcpToken: nonEmpty(env.GITQUIRE_MCP_TOKEN),
    sessionMaxAgeSeconds: Math.round(sessionDays * 24 * 60 * 60),
    githubWebUrl: stripTrailingSlash(
      nonEmpty(env.GITQUIRE_GITHUB_WEB_URL) ?? 'https://github.com',
    ),
    githubApiUrl: stripTrailingSlash(
      nonEmpty(env.GITQUIRE_GITHUB_API_URL) ?? 'https://api.github.com',
    ),
  };
}
