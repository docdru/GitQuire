import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CheckPushPermissionOptions, DetectGhFn, PushPermission } from '../github-permissions.ts';
import type { GateLogger } from './access-gate.ts';
import { type GitHubRepoRef, parseGitHubRepo } from './github-auth-config.ts';

const GITHUB_API_VERSION = '2022-11-28';
const REFRESH_BEFORE_EXPIRY_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;

export interface GitHubAppConfig {
  appId: string;
  privateKeyPem: string;
  repo: GitHubRepoRef;
  branch: string | undefined;
  githubApiUrl: string;
  gitHost: string;
}

export class GitHubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubUnavailableError';
  }
}

export class GitHubAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAppConfigError';
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function resolveGitHubAppConfig(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): GitHubAppConfig | undefined {
  const appId = nonEmpty(env.GITHUB_APP_ID);
  const inlineKey = nonEmpty(env.GITHUB_APP_PRIVATE_KEY);
  const keyFile = nonEmpty(env.GITHUB_APP_PRIVATE_KEY_FILE);
  if (appId === undefined && inlineKey === undefined && keyFile === undefined) return undefined;

  const missing: string[] = [];
  if (appId === undefined) missing.push('GITHUB_APP_ID');
  if (inlineKey === undefined && keyFile === undefined) {
    missing.push('GITHUB_APP_PRIVATE_KEY_FILE (or GITHUB_APP_PRIVATE_KEY)');
  }
  if (nonEmpty(env.GITQUIRE_REPO) === undefined) missing.push('GITQUIRE_REPO');
  if (appId === undefined || missing.length > 0) {
    throw new GitHubAppConfigError(
      `GitHub repository sync is enabled but these settings are missing: ${missing.join(', ')}.`,
    );
  }

  let privateKeyPem: string;
  if (inlineKey !== undefined) {
    privateKeyPem = inlineKey.replace(/\\n/g, '\n');
  } else {
    try {
      privateKeyPem = readFile(keyFile as string);
    } catch (err) {
      throw new GitHubAppConfigError(
        `Could not read GITHUB_APP_PRIVATE_KEY_FILE (${keyFile}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!privateKeyPem.includes('PRIVATE KEY-----')) {
    throw new GitHubAppConfigError(
      'The GitHub App private key is not a PEM file. Download it from the app settings page.',
    );
  }

  const repo = parseGitHubRepo(env.GITQUIRE_REPO);
  if (repo === undefined) {
    throw new GitHubAppConfigError('GITQUIRE_REPO is required for repository sync.');
  }

  return {
    appId,
    privateKeyPem,
    repo,
    branch: nonEmpty(env.GITQUIRE_BRANCH),
    githubApiUrl: (nonEmpty(env.GITQUIRE_GITHUB_API_URL) ?? 'https://api.github.com').replace(
      /\/+$/,
      '',
    ),
    gitHost: gitHostFrom(env.GITQUIRE_GITHUB_WEB_URL),
  };
}

function gitHostFrom(webUrl: string | undefined): string {
  const raw = nonEmpty(webUrl);
  if (raw === undefined) return 'github.com';
  try {
    return new URL(raw).host;
  } catch {
    throw new GitHubAppConfigError(`GITQUIRE_GITHUB_WEB_URL is not a valid URL: "${raw}".`);
  }
}

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000, 60_000,
];

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: GitHubUnavailableError, attempt: number, delayMs: number) => void;
}

export async function retryWhileUnavailable<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const delay = delays.at(attempt);
      if (!(err instanceof GitHubUnavailableError) || delay === undefined) throw err;
      options.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
}

export function createAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem).toString('base64url')}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
  contents?: string;
}

export type CheckPushPermissionFn = (opts: CheckPushPermissionOptions) => Promise<PushPermission>;

export interface RepoInfo {
  defaultBranch: string;
  cloneUrl: string;
}

export interface GitHubAppClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
  retry?: RetryOptions;
}

export interface GitHubAppClient {
  mintInstallationToken: () => Promise<InstallationToken>;
  repoInfo: (token: string) => Promise<RepoInfo>;
}

export function createGitHubAppClient(
  config: GitHubAppConfig,
  deps: GitHubAppClientDeps = {},
): GitHubAppClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const repoPath = `${encodeURIComponent(config.repo.owner)}/${encodeURIComponent(config.repo.name)}`;

  async function call(
    path: string,
    bearer: string,
    init: { method?: string; body?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await doFetch(`${config.githubApiUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${bearer}`,
          'User-Agent': 'GitQuire',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    } catch (err) {
      throw new GitHubUnavailableError(
        `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (response.status >= 500 || response.status === 429) {
      throw new GitHubUnavailableError(`GitHub answered HTTP ${response.status}.`);
    }
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = text === '' ? {} : JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: response.status, body };
  }

  function describe(status: number, body: Record<string, unknown>): string {
    const message = typeof body.message === 'string' ? body.message : 'no message';
    return `HTTP ${status}: ${message}`;
  }

  async function mintInstallationToken(): Promise<InstallationToken> {
    const jwt = createAppJwt(config.appId, config.privateKeyPem, now());
    const installation = await call(`/repos/${repoPath}/installation`, jwt);
    if (installation.status !== 200 || typeof installation.body.id !== 'number') {
      throw new GitHubAppConfigError(
        `The GitHub App ${config.appId} is not installed on ${config.repo.owner}/${config.repo.name} (${describe(installation.status, installation.body)}). Install it from the app's settings page.`,
      );
    }
    const minted = await call(`/app/installations/${installation.body.id}/access_tokens`, jwt, {
      method: 'POST',
      body: JSON.stringify({ repositories: [config.repo.name] }),
    });
    const token = minted.body.token;
    const expiresAt = minted.body.expires_at;
    if (minted.status !== 201 || typeof token !== 'string' || typeof expiresAt !== 'string') {
      throw new GitHubAppConfigError(
        `Could not create an installation token (${describe(minted.status, minted.body)}).`,
      );
    }
    const permissions = minted.body.permissions;
    const contents =
      typeof permissions === 'object' && permissions !== null
        ? (permissions as Record<string, unknown>).contents
        : undefined;
    return {
      token,
      expiresAt: Date.parse(expiresAt),
      ...(typeof contents === 'string' ? { contents } : {}),
    };
  }

  async function repoInfo(token: string): Promise<RepoInfo> {
    const repo = await call(`/repos/${repoPath}`, token);
    if (repo.status !== 200 || typeof repo.body.default_branch !== 'string') {
      throw new GitHubAppConfigError(
        `Could not read ${config.repo.owner}/${config.repo.name} (${describe(repo.status, repo.body)}).`,
      );
    }
    return {
      defaultBranch: repo.body.default_branch,
      cloneUrl: `https://${config.gitHost}/${config.repo.owner}/${config.repo.name}.git`,
    };
  }

  return {
    mintInstallationToken: () => retryWhileUnavailable(mintInstallationToken, deps.retry),
    repoInfo: (token) => retryWhileUnavailable(() => repoInfo(token), deps.retry),
  };
}

export interface InstallationTokenManager {
  current: () => string | undefined;
  wrapDetectGh: (fallback: DetectGhFn | undefined) => DetectGhFn;
  wrapCheckPushPermission: (fallback: CheckPushPermissionFn) => CheckPushPermissionFn;
  stop: () => void;
}

export interface TokenManagerDeps {
  log: GateLogger;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
}

export async function startInstallationTokenManager(
  config: GitHubAppConfig,
  client: GitHubAppClient,
  deps: TokenManagerDeps,
): Promise<InstallationTokenManager> {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  let current = await client.mintInstallationToken();
  let timer: unknown;
  let stopped = false;

  function schedule(delayMs: number): void {
    if (stopped) return;
    const handle = setTimer(
      () => {
        void refresh();
      },
      Math.max(1000, delayMs),
    );
    handle.unref?.();
    timer = handle;
  }

  async function refresh(): Promise<void> {
    try {
      current = await client.mintInstallationToken();
      deps.log.info(
        { expiresAt: new Date(current.expiresAt).toISOString() },
        '[gitquire-app] refreshed installation token',
      );
      schedule(current.expiresAt - now() - REFRESH_BEFORE_EXPIRY_MS);
    } catch (err) {
      deps.log.warn({ err }, '[gitquire-app] installation token refresh failed; retrying');
      schedule(RETRY_AFTER_FAILURE_MS);
    }
  }

  schedule(current.expiresAt - now() - REFRESH_BEFORE_EXPIRY_MS);
  deps.log.info(
    { repo: `${config.repo.owner}/${config.repo.name}` },
    '[gitquire-app] using GitHub App installation token for git sync',
  );

  function valid(): string | undefined {
    return current.expiresAt > now() ? current.token : undefined;
  }

  function isAppRepo(opts: CheckPushPermissionOptions): boolean {
    return (
      (opts.host ?? 'github.com').toLowerCase() === config.gitHost.toLowerCase() &&
      opts.owner.toLowerCase() === config.repo.owner.toLowerCase() &&
      opts.repo.replace(/\.git$/i, '').toLowerCase() === config.repo.name.toLowerCase()
    );
  }

  return {
    current: valid,
    wrapCheckPushPermission(fallback) {
      return async (opts) => {
        if (!isAppRepo(opts) || current.contents === undefined) return fallback(opts);
        if (valid() === undefined) return { kind: 'unknown', error: 'token-invalid' };
        return current.contents === 'write'
          ? { kind: 'allowed' }
          : { kind: 'denied', reason: 'no-collaborator' };
      };
    },
    wrapDetectGh(fallback) {
      return (host, options) => {
        const token = host === undefined || host === config.gitHost ? valid() : undefined;
        if (token !== undefined) return { available: true, token };
        return fallback === undefined ? { available: false } : fallback(host, options);
      };
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
    },
  };
}
