import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkPushPermission, type DetectGhFn } from '../github-permissions.ts';
import type { AccessGate, GateLogger } from './access-gate.ts';
import { createAccessGate, principalFromUser } from './access-gate.ts';
import { createRepoAccessCheck, startAccessSweep } from './agent-access.ts';
import { type AgentTokenStore, createAgentTokenStore } from './agent-tokens.ts';
import {
  type CheckPushPermissionFn,
  createGitHubAppClient,
  type InstallationTokenManager,
  resolveGitHubAppConfig,
  startInstallationTokenManager,
} from './github-app.ts';
import { resolveGitHubAuthConfig } from './github-auth-config.ts';
import { createGitHubPullsClient } from './github-pulls.ts';
import type { ScanFilter } from './page-scan.ts';
import { setSessionPrincipalResolver } from './principal-directory.ts';
import {
  bootstrapRepository,
  ensureAutoSyncMode,
  parseAutoSyncMode,
  runGitSync,
} from './repo-bootstrap.ts';
import { createGitQuireRoutes } from './routes.ts';
import { setAdminResolver } from './settings-admin.ts';

export type { AccessGate, SessionUser } from './access-gate.ts';
export { noreplyEmail } from './access-gate.ts';
export { GitHubAppConfigError, GitHubUnavailableError } from './github-app.ts';
export { GitHubAuthConfigError } from './github-auth-config.ts';

type Env = Readonly<Record<string, string | undefined>>;

export function agentTokensFile(env: Env, projectDir: string): string {
  const override = env.GITQUIRE_AGENT_TOKENS_FILE?.trim();
  if (override !== undefined && override !== '') return override;
  return join(projectDir, '.ok', 'local', 'gitquire', 'agent-tokens.json');
}

export function createAccessGateFromEnv(
  env: Env,
  runtime: { externalUrl: string | undefined },
  log: GateLogger,
  options: {
    projectDir?: string;
    tokens?: InstallationTokenManager;
  } = {},
): AccessGate | undefined {
  const config = resolveGitHubAuthConfig(env, runtime);
  if (config === undefined) return undefined;
  let agentTokens: AgentTokenStore | undefined;
  const check = createRepoAccessCheck(config, { installationToken: options.tokens?.current });
  if (options.projectDir !== undefined) {
    agentTokens = createAgentTokenStore({ file: agentTokensFile(env, options.projectDir), log });
    const sweep = startAccessSweep(agentTokens, check, { log });
    sweep.runOnce().catch((err: unknown) => {
      log.warn({ err }, '[gitquire-agents] initial access check failed');
    });
  }
  const access =
    config.repo === undefined
      ? `allowed users: ${[...config.allowedUsers].join(', ')}`
      : `write access to ${config.repo.owner}/${config.repo.name}`;
  log.info(
    {
      externalUrl: config.externalUrl.toString(),
      mcpToken: config.mcpToken !== undefined,
      mcpConnectors: config.mcpConnectors,
    },
    `[gitquire-auth] GitHub sign-in enabled (${access})`,
  );
  if (config.mcpConnectors && config.externalUrl.protocol !== 'https:') {
    log.warn(
      { externalUrl: config.externalUrl.toString() },
      '[gitquire-auth] GITQUIRE_MCP_CONNECTORS is on, but Claude and other cloud connectors need an https:// OK_EXTERNAL_URL',
    );
  }
  const gate = createAccessGate(config, { log, agentTokens, checkAccess: check });
  setSessionPrincipalResolver((req) => {
    const user = gate.sessionUser(req);
    return user === undefined ? undefined : principalFromUser(user);
  });
  setAdminResolver(gate.isAdminRequest);
  return gate;
}

export async function startGitHubAppTokensFromEnv(
  env: Env,
  log: GateLogger,
): Promise<InstallationTokenManager | undefined> {
  const config = resolveGitHubAppConfig(env);
  if (config === undefined) return undefined;
  const client = createGitHubAppClient(config, {
    retry: {
      onRetry: (err, attempt, delayMs) =>
        log.warn({ attempt, delayMs, reason: err.message }, '[gitquire-app] GitHub unavailable'),
    },
  });
  return startInstallationTokenManager(config, client, { log });
}

export function withGitHubAppPushCheck(
  manager: InstallationTokenManager | undefined,
): CheckPushPermissionFn | undefined {
  return manager?.wrapCheckPushPermission(checkPushPermission);
}

export function withGitHubAppToken(
  manager: InstallationTokenManager | undefined,
  detectGh: DetectGhFn | undefined,
): DetectGhFn | undefined {
  return manager === undefined ? detectGh : manager.wrapDetectGh(detectGh);
}

export interface GitQuireBootstrapResult {
  configured: boolean;
  message: string;
}

export async function runGitQuireBootstrap(
  dir: string,
  env: Env,
  initProject: (dir: string) => void,
  warn: (message: string) => void = () => {},
): Promise<GitQuireBootstrapResult> {
  const config = resolveGitHubAppConfig(env);
  if (config === undefined) {
    return { configured: false, message: 'GitHub repository sync is not configured.' };
  }
  const syncMode = parseAutoSyncMode(env.GITQUIRE_SYNC_MODE);
  const client = createGitHubAppClient(config, {
    retry: {
      onRetry: (err, attempt, delayMs) =>
        warn(`${err.message} Retrying in ${Math.round(delayMs / 1000)} s (attempt ${attempt}).`),
    },
  });
  const outcome = await bootstrapRepository(dir, config, client);
  runGitSync(['config', 'fetch.prune', 'true'], dir);
  if (!existsSync(join(dir, '.ok'))) initProject(dir);
  const sync = ensureAutoSyncMode(dir, syncMode);
  const repo = `${config.repo.owner}/${config.repo.name}`;
  const what =
    outcome.action === 'cloned'
      ? `Cloned ${repo} (${outcome.branch})`
      : outcome.action === 'initialized-empty'
        ? `${repo} is empty; started branch ${outcome.branch}`
        : `Using the existing checkout of ${repo}`;
  const syncNote =
    sync === 'written' ? `sync mode set to ${syncMode}` : 'sync mode kept from local config';
  return { configured: true, message: `${what}; ${syncNote}.` };
}

export function initProjectWithCli(cliArgs: readonly string[]): (dir: string) => void {
  return (dir) => {
    execFileSync(
      cliArgs[0] ?? process.execPath,
      [...cliArgs.slice(1), 'init', '--no-mcp', '--no-skills', '--local-only'],
      { cwd: dir, stdio: 'inherit', windowsHide: true },
    );
  };
}

const INTERACTIVE_RETRY_DELAYS_MS = [500, 2000] as const;

export function createGitQuireHttp(
  env: Env,
  options: {
    projectDir: string;
    contentDir?: string;
    gate: AccessGate | undefined;
    tokens: InstallationTokenManager | undefined;
    log: GateLogger;
  },
): GitQuireHttp {
  const appConfig = options.tokens === undefined ? undefined : resolveGitHubAppConfig(env);
  const pulls =
    appConfig === undefined || options.tokens === undefined
      ? undefined
      : createGitHubPullsClient(appConfig.repo, {
          token: options.tokens.current,
          apiUrl: appConfig.githubApiUrl,
          retry: { delaysMs: INTERACTIVE_RETRY_DELAYS_MS },
        });
  let contentFilter: ScanFilter | undefined;
  const routes = createGitQuireRoutes({
    projectDir: options.projectDir,
    contentDir: options.contentDir,
    contentFilter: () => contentFilter,
    log: options.log,
    pulls,
    baseBranch: appConfig?.branch,
    sessionUser: options.gate?.sessionUser,
  });
  const gate = options.gate;
  return {
    handleRequest: (req, res) =>
      (gate?.handleRequest(req, res) ?? false) || routes.handle(req, res),
    admitUpgrade: (req, socket) => gate?.admitUpgrade(req, socket) ?? true,
    sessionUser: (req) => gate?.sessionUser(req),
    isAdminRequest: (req) => gate?.isAdminRequest(req) ?? true,
    useContentFilter: (filter) => {
      contentFilter = filter;
    },
  };
}

export interface GitQuireHttp extends AccessGate {
  useContentFilter: (filter: ScanFilter) => void;
}
