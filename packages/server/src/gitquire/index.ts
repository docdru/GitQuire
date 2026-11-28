import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkPushPermission, type DetectGhFn } from '../github-permissions.ts';
import type { AccessGate, GateLogger } from './access-gate.ts';
import { createAccessGate, principalFromUser } from './access-gate.ts';
import { createRepoAccessCheck, startAccessSweep } from './agent-access.ts';
import { type AgentTokenStore, createAgentTokenStore } from './agent-tokens.ts';
import { ensureAgentsFile } from './agents-file.ts';
import {
  createBehindFrontDoorGate,
  resolveBehindFrontDoorSettings,
} from './behind-front-door-gate.ts';
import { createChatFromEnv } from './chat/setup.ts';
import { type DoorSyncConfig, fetchDoorToken, resolveDoorSyncConfig } from './door-token.ts';
import type { RepoSyncConfig } from './drafts/setup.ts';
import {
  createDrafts,
  type Drafts,
  isDraftInstance,
  type LiveServerHandle,
} from './drafts/setup.ts';
import { createForgejoPullsClient } from './forgejo-pulls.ts';
import { furtherHostKeys } from './front-door/hosts.ts';
import {
  type CheckPushPermissionFn,
  createGitHubAppClient,
  type GitHubAppClient,
  type GitHubAppConfig,
  GitHubAppConfigError,
  GitHubUnavailableError,
  type InstallationTokenManager,
  type RetryOptions,
  resolveGitHubAppConfig,
  retryWhileUnavailable,
  startInstallationTokenManager,
} from './github-app.ts';
import { resolveGitHubAuthConfig } from './github-auth-config.ts';
import { createGitHubPullsClient, type GitHubDraftsClient } from './github-pulls.ts';
import { checkDataFolderHost } from './host/data-folder.ts';
import { createForgejoDoorHost } from './host/forgejo.ts';
import {
  createForgejoRepoClient,
  type ForgejoRepoConfig,
  resolveForgejoRepoConfig,
} from './host/forgejo-repo.ts';
import { createGitHubDoorHost } from './host/github.ts';
import { HostConfigError, hostNamesFromEnv, parseHostKind, setHostNames } from './host/names.ts';
import type { DoorHost, HostNames } from './host/types.ts';
import {
  describeLegacyDataFolderMigration,
  migrateLegacyDataFolders,
} from './legacy-data-folder.ts';
import type { ScanFilter } from './page-scan.ts';
import { setSessionPrincipalResolver } from './principal-directory.ts';
import { createStopStateRoute, projectStopState } from './process-pool/stop-state.ts';
import {
  bootstrapRepository,
  ensureAutoSyncMode,
  parseAutoSyncMode,
  runGitSync,
} from './repo-bootstrap.ts';
import { createRepoPin, type RepoPin } from './repo-pin.ts';
import { behindFrontDoorFromEnv, type RequestPerson } from './request-person.ts';
import { createGitQuireRoutes } from './routes.ts';
import { setAdminResolver } from './settings-admin.ts';
import { interruptedMove } from './volume-markers.ts';

export type { AccessGate } from './access-gate.ts';

export { GitHubAppConfigError, GitHubUnavailableError } from './github-app.ts';

function doorRepoClient(door: DoorSyncConfig, retry?: RetryOptions): GitHubAppClient {
  const repoInfo =
    door.host === 'forgejo'
      ? createForgejoRepoClient(
          {
            repo: door.repo,
            branch: door.branch,
            webUrl: door.webUrl,
            apiUrl: door.apiUrl,
            gitHost: door.gitHost,
            botToken: undefined,
            repoToken: '',
          },
          { retry },
        ).repoInfo
      : createGitHubAppClient(
          {
            appId: '',
            privateKeyPem: '',
            repo: door.repo,
            branch: door.branch,
            githubApiUrl: door.apiUrl,
            githubWebUrl: door.webUrl,
            gitHost: door.gitHost,
          },
          { retry },
        ).repoInfo;
  return {
    mintInstallationToken: () => retryWhileUnavailable(() => fetchDoorToken(door.socket), retry),
    repoInfo,
  };
}

function forgejoRepoConfig(env: Env): ForgejoRepoConfig | undefined {
  return resolveForgejoRepoConfig(env, { needBotToken: !isDraftInstance(env) });
}

function doorHostFor(
  env: Env,
  config: {
    githubWebUrl: string;
    githubApiUrl: string;
    repo: { owner: string; name: string } | undefined;
  },
  tokens: InstallationTokenManager | undefined,
): DoorHost {
  if (parseHostKind(env) === 'forgejo') {
    const forgejo = forgejoRepoConfig(env);
    return createForgejoDoorHost(
      { webUrl: config.githubWebUrl, apiUrl: config.githubApiUrl, repo: config.repo },
      { botToken: () => forgejo?.botToken, repoToken: () => forgejo?.repoToken },
    );
  }
  return createGitHubDoorHost(
    { webUrl: config.githubWebUrl, apiUrl: config.githubApiUrl, repo: config.repo },
    { installationToken: tokens?.current },
  );
}

async function checkForgejoHost(
  config: ForgejoRepoConfig,
  onRetry: (err: Error, attempt: number, delayMs: number) => void,
): Promise<void> {
  const door = createForgejoDoorHost(
    { webUrl: config.webUrl, apiUrl: config.apiUrl, repo: config.repo },
    { botToken: () => config.botToken, repoToken: () => config.repoToken },
  );
  await retryWhileUnavailable(
    async () => {
      const result = await door.selfCheck();
      if (result.ok) return;
      if (result.unreachable) throw new GitHubUnavailableError(result.problems.join(' '));
      throw new GitHubAppConfigError(result.problems.join(' '));
    },
    { onRetry },
  );
}

export { GitHubAuthConfigError } from './github-auth-config.ts';
export { HostConfigError } from './host/names.ts';

type Env = Readonly<Record<string, string | undefined>>;

export function configureHostFromEnv(env: Env, projectDir: string | undefined): HostNames {
  if (!behindFrontDoorFromEnv(env) && furtherHostKeys(env).length > 0) {
    throw new HostConfigError(
      'GITQUIRE_HOSTS adds Git hosts to the front door (GITQUIRE_WIKIS=on). A single wiki has one host (GITQUIRE_HOST); remove GITQUIRE_HOSTS.',
    );
  }
  if (projectDir !== undefined && !behindFrontDoorFromEnv(env)) refuseFrontDoorVolume(projectDir);
  const names = hostNamesFromEnv(env);
  if (projectDir !== undefined && !isDraftInstance(env)) {
    checkDataFolderHost(projectDir, names.kind, [agentTokensFile(env, projectDir)]);
  }
  setHostNames(names);
  return names;
}

export function refuseFrontDoorVolume(projectDir: string): void {
  if (interruptedMove(projectDir)) {
    throw new HostConfigError(
      `${projectDir} is in the middle of moving a single wiki over, which GitQuire no longer does. Nothing on it was changed.`,
    );
  }
  if (
    !existsSync(join(projectDir, '.git')) &&
    existsSync(join(projectDir, 'server', 'wikis.json'))
  ) {
    throw new HostConfigError(
      `${projectDir} holds several wikis (server/wikis.json). Start it with GITQUIRE_WIKIS=on, or give this single wiki a volume of its own.`,
    );
  }
}

function agentTokensFile(env: Env, projectDir: string): string {
  const override = env.GITQUIRE_AGENT_TOKENS_FILE?.trim();
  if (override !== undefined && override !== '') return override;
  return join(projectDir, '.gitquire', 'local', 'gitquire', 'agent-tokens.json');
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
  if (behindFrontDoorFromEnv(env)) {
    const settings = resolveBehindFrontDoorSettings(env);
    log.info(
      { repo: settings.repo ?? null },
      '[gitquire-auth] behind the front door: only requests with the internal secret are served, the person comes from the front door',
    );
    const gate = createBehindFrontDoorGate(settings, { log });
    installRequestPerson(gate);
    return gate;
  }
  const config = resolveGitHubAuthConfig(env, runtime);
  if (config === undefined) return undefined;
  let agentTokens: AgentTokenStore | undefined;
  const host = doorHostFor(env, config, options.tokens);
  const check = createRepoAccessCheck(config, { host });
  if (options.projectDir !== undefined && !isDraftInstance(env)) {
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
      '[gitquire-auth] GITQUIRE_MCP_CONNECTORS is on, but Claude and other cloud connectors need an https:// GITQUIRE_EXTERNAL_URL',
    );
  }
  const gate = createAccessGate(config, { log, agentTokens, checkAccess: check, host });
  installRequestPerson(gate);
  return gate;
}

function installRequestPerson(person: Pick<RequestPerson, 'sessionUser' | 'isAdminRequest'>): void {
  setSessionPrincipalResolver((req) => {
    const user = person.sessionUser(req);
    return user === undefined ? undefined : principalFromUser(user);
  });
  setAdminResolver(person.isAdminRequest);
}

export async function startGitHubAppTokensFromEnv(
  env: Env,
  log: GateLogger,
): Promise<InstallationTokenManager | undefined> {
  const door = resolveDoorSyncConfig(env);
  if (door !== undefined) {
    return startInstallationTokenManager(
      door,
      doorRepoClient(door, {
        onRetry: (err, attempt, delayMs) =>
          log.warn({ attempt, delayMs, reason: err.message }, '[gitquire-host] no token yet'),
      }),
      { log, startMessage: "[gitquire-host] using the front door's token for this wiki" },
    );
  }
  const forgejo = forgejoRepoConfig(env);
  if (forgejo !== undefined) {
    if (!isDraftInstance(env)) {
      await checkForgejoHost(forgejo, (err, attempt, delayMs) =>
        log.warn({ attempt, delayMs, reason: err.message }, '[gitquire-host] Forgejo unavailable'),
      );
    }
    return startInstallationTokenManager(forgejo, createForgejoRepoClient(forgejo), {
      log,
      startMessage: '[gitquire-host] using the Forgejo repository token for git sync',
    });
  }
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

export function doorSyncPinFromEnv(
  env: Env,
  manager: InstallationTokenManager | undefined,
  projectDir: string,
  log: GateLogger,
): RepoPin | undefined {
  const door = resolveDoorSyncConfig(env);
  if (door === undefined || door.repoId === undefined || manager === undefined) return undefined;
  return createRepoPin(
    {
      repoId: door.repoId,
      repo: door.repo,
      apiUrl: door.apiUrl,
      originUrl: () => readOriginUrl(projectDir),
    },
    { token: () => manager.current(), log },
  );
}

function readOriginUrl(projectDir: string): string | undefined {
  try {
    const url = runGitSync(['config', '--get', 'remote.origin.url'], projectDir).trim();
    return url === '' ? undefined : url;
  } catch {
    return undefined;
  }
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

interface GitQuireBootstrapResult {
  configured: boolean;
  message: string;
}

export async function runGitQuireBootstrap(
  dir: string,
  env: Env,
  initProject: (dir: string) => void,
  warn: (message: string) => void = () => {},
): Promise<GitQuireBootstrapResult> {
  const retry = {
    onRetry: (err: Error, attempt: number, delayMs: number) =>
      warn(`${err.message} Retrying in ${Math.round(delayMs / 1000)} s (attempt ${attempt}).`),
  };
  const door = resolveDoorSyncConfig(env);
  const forgejo = door === undefined ? forgejoRepoConfig(env) : undefined;
  const github =
    door === undefined && forgejo === undefined ? resolveGitHubAppConfig(env) : undefined;
  let config: ForgejoRepoConfig | GitHubAppConfig | DoorSyncConfig;
  let client: GitHubAppClient;
  if (door !== undefined) {
    config = door;
    client = doorRepoClient(door, retry);
  } else if (forgejo !== undefined) {
    await checkForgejoHost(forgejo, retry.onRetry);
    config = forgejo;
    client = createForgejoRepoClient(forgejo, { retry });
  } else if (github !== undefined) {
    config = github;
    client = createGitHubAppClient(github, { retry });
  } else {
    return { configured: false, message: 'GitHub repository sync is not configured.' };
  }
  const syncMode = parseAutoSyncMode(env.GITQUIRE_SYNC_MODE);
  if (!behindFrontDoorFromEnv(env)) refuseFrontDoorVolume(dir);
  const outcome = await bootstrapRepository(dir, config, client);
  runGitSync(['config', 'fetch.prune', 'true'], dir);
  for (const line of describeLegacyDataFolderMigration(migrateLegacyDataFolders(dir))) warn(line);
  if (!existsSync(join(dir, '.gitquire'))) initProject(dir);
  configureHostFromEnv(env, dir);
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
    execFileSync(cliArgs[0] ?? process.execPath, [...cliArgs.slice(1), 'init', '--local-only'], {
      cwd: dir,
      stdio: 'inherit',
    });
  };
}

const INTERACTIVE_RETRY_DELAYS_MS = [500, 2000] as const;

interface RepoSync {
  config: RepoSyncConfig;
  client: (token: () => string | undefined) => GitHubDraftsClient;
}

function repoSyncFromEnv(env: Env): RepoSync | undefined {
  const door = resolveDoorSyncConfig(env);
  if (door !== undefined) {
    return {
      config: {
        host: door.host,
        repo: door.repo,
        branch: door.branch,
        gitHost: door.gitHost,
        webUrl: door.webUrl,
      },
      client: (token) =>
        door.host === 'forgejo'
          ? createForgejoPullsClient(door.repo, {
              token,
              apiUrl: door.apiUrl,
              retry: { delaysMs: INTERACTIVE_RETRY_DELAYS_MS },
            })
          : createGitHubPullsClient(door.repo, {
              token,
              apiUrl: door.apiUrl,
              retry: { delaysMs: INTERACTIVE_RETRY_DELAYS_MS },
            }),
    };
  }
  const forgejo = forgejoRepoConfig(env);
  if (forgejo !== undefined) {
    return {
      config: {
        host: 'forgejo',
        repo: forgejo.repo,
        branch: forgejo.branch,
        gitHost: forgejo.gitHost,
        webUrl: forgejo.webUrl,
      },
      client: (token) =>
        createForgejoPullsClient(forgejo.repo, {
          token,
          apiUrl: forgejo.apiUrl,
          retry: { delaysMs: INTERACTIVE_RETRY_DELAYS_MS },
        }),
    };
  }
  const github = resolveGitHubAppConfig(env);
  if (github === undefined) return undefined;
  return {
    config: {
      host: 'github',
      repo: github.repo,
      branch: github.branch,
      gitHost: github.gitHost,
      webUrl: github.githubWebUrl,
    },
    client: (token) =>
      createGitHubPullsClient(github.repo, {
        token,
        apiUrl: github.githubApiUrl,
        retry: { delaysMs: INTERACTIVE_RETRY_DELAYS_MS },
      }),
  };
}

function writeAgentsFile(env: Env, dir: string, log: GateLogger): void {
  try {
    const outcome = ensureAgentsFile(dir, env);
    if (outcome === 'created' || outcome === 'updated') {
      log.info({ outcome }, `[gitquire] ${outcome} the GitQuire section of AGENTS.md`);
    }
  } catch (err) {
    log.warn({ err }, '[gitquire] could not write the GitQuire section of AGENTS.md');
  }
}

export function createGitQuireHttp(
  env: Env,
  options: {
    projectDir: string;
    contentDir?: string;
    gate: AccessGate | undefined;
    tokens: InstallationTokenManager | undefined;
    log: GateLogger;
    cli?: readonly string[];
    liveServer?: LiveServerHandle;
    ownPort?: () => number | undefined;
    repoPin?: RepoPin;
  },
): GitQuireHttp {
  const repoSync = options.tokens === undefined ? undefined : repoSyncFromEnv(env);
  const pulls =
    repoSync === undefined || options.tokens === undefined
      ? undefined
      : repoSync.client(options.tokens.current);
  const appConfig = repoSync?.config;
  const gate = options.gate;
  const drafts: Drafts | undefined =
    gate === undefined
      ? undefined
      : createDrafts({
          env,
          projectDir: options.projectDir,
          log: options.log,
          sessionUser: gate.sessionUser,
          agentOwner: (req) => gate.agentOwner?.(req),
          secure: (env.GITQUIRE_EXTERNAL_URL ?? '').trim().startsWith('https:'),
          behindFrontDoor: behindFrontDoorFromEnv(env),
          appConfig,
          client: pulls,
          token: () => options.tokens?.current(),
          cli: options.cli ?? [process.execPath, process.argv[1] ?? ''],
          initProject: initProjectWithCli(options.cli ?? [process.execPath, process.argv[1] ?? '']),
          liveServer: options.liveServer,
          repoPin: options.repoPin,
        });
  if (!isDraftInstance(env))
    writeAgentsFile(env, options.contentDir ?? options.projectDir, options.log);
  let contentFilter: ScanFilter | undefined;
  const routes = createGitQuireRoutes({
    projectDir: options.projectDir,
    contentDir: options.contentDir,
    contentFilter: () => contentFilter,
    log: options.log,
    pulls,
    baseBranch: appConfig?.branch,
    sessionUser: options.gate?.sessionUser,
    extraMentions: drafts === undefined ? undefined : () => drafts.service.reviewMentions(),
    notify: !isDraftInstance(env),
    ...(gate?.accessOf === undefined ? {} : { canOpen: gate.accessOf }),
  });
  if (routes.recordAddress !== undefined) {
    const record = routes.recordAddress;
    gate?.onAccountAddress?.((user, found) => record(user, found));
  }
  const chat =
    gate === undefined || isDraftInstance(env)
      ? undefined
      : createChatFromEnv(env, {
          projectDir: options.projectDir,
          sessionUser: gate.sessionUser,
          log: options.log,
          ownPort: options.ownPort,
          ...(routes.peopleStore === undefined ? {} : { people: routes.peopleStore }),
        });
  const stopState = createStopStateRoute(() =>
    projectStopState(
      options.projectDir,
      runGitSync,
      drafts === undefined ? async () => ({ pushedAndClean: true }) : drafts.instances.stopState,
    ),
  );
  return {
    handleRequest: (req, res) =>
      (gate?.handleRequest(req, res) ?? false) ||
      stopState(req, res) ||
      (drafts?.http.handleRequest(req, res) ?? false) ||
      (chat?.handle(req, res) ?? false) ||
      routes.handle(req, res),
    admitUpgrade: (req, socket) => gate?.admitUpgrade(req, socket) ?? true,
    routeUpgrade: (req, socket, head) => drafts?.http.handleUpgrade(req, socket, head) ?? false,
    sessionUser: (req) => gate?.sessionUser(req),
    isAdminRequest: (req) => gate?.isAdminRequest(req) ?? true,
    useContentFilter: (filter) => {
      contentFilter = filter;
    },
    stopChildren: async () => {
      await drafts?.stop();
    },
  };
}

export interface GitQuireHttp extends AccessGate {
  useContentFilter: (filter: ScanFilter) => void;
  stopChildren: () => Promise<void>;
}
