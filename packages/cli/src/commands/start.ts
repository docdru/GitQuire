import { existsSync as fsExistsSync, realpathSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { basename, resolve as pathResolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  applyConfigOverlay,
  currentCliCommandName,
  DEFAULT_SERVER_HOST,
  type EnvConfigLayer,
  EnvVarError,
  IDLE_SHUTDOWN_DURATION_RE,
  idleShutdownToMs,
  resolveEnvConfigLayer,
  resolveServerRuntimeConfig,
  type ServerRuntimeConfig,
} from '@gitquire/core';
import {
  type BootedServer,
  type Config,
  isProjectRoot,
  lockAdvertisesUi,
  type PinoLogger,
  type ServerExitDetail,
  type ServerExitReason,
} from '@gitquire/server';
import { Command, InvalidArgumentError, Option } from 'commander';
import { makeLazyEmbeddingsKeyStore } from '../auth/embeddings-key-store.ts';
import { detectGh, detectGhAccounts } from '../auth/gh-detect.ts';
import { makeLazyProbeTokenStore } from '../auth/token-store.ts';
import { PACKAGE_VERSION } from '../constants.ts';

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export function resolveHost(
  opts: { bind?: string[] },
  env: { HOST?: string | undefined; [key: string]: string | undefined },
): string {
  return opts.bind?.[0] ?? env.HOST ?? DEFAULT_SERVER_HOST;
}

export type OnlyModule = 'server';

export function parseOnlyModule(value: string): OnlyModule {
  if (value === 'server') return value;
  throw new InvalidArgumentError("--only must be 'server'");
}

export function resolveBundledReactShellDir(
  existsFn: (path: string) => boolean = fsExistsSync,
  cliDir: string = import.meta.dirname ?? new URL('.', import.meta.url).pathname,
): string | undefined {
  const candidates = [
    pathResolve(cliDir, 'public'),
    pathResolve(cliDir, '../../app/dist'),
    pathResolve(cliDir, '../../../app/dist'),
  ];
  if (existsFn(pathResolve(cliDir, '../../app.asar'))) {
    candidates.push(pathResolve(cliDir, '../../app'));
  }
  return candidates.find((p) => existsFn(p));
}

export function resolveStartShellDir(input: {
  explicitDir: string | undefined;
  only: OnlyModule | undefined;
  findBundledDir: () => string | undefined;
}): { dir: string | undefined; missingBundle: boolean } {
  if (input.explicitDir !== undefined) return { dir: input.explicitDir, missingBundle: false };
  if (input.only === 'server') return { dir: undefined, missingBundle: false };
  const dir = input.findBundledDir();
  return { dir, missingBundle: dir === undefined };
}

export function parseIdleShutdownFlag(value: string): string {
  if (value === 'off') return 'off';
  if (!IDLE_SHUTDOWN_DURATION_RE.test(value)) {
    throw new InvalidArgumentError("--idle-shutdown must be 'off' or a duration like 90s, 30m, 2h");
  }
  return value;
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

export function shouldWarnHostOverridesMultiBind(input: {
  flagBindSet: boolean;
  okBindSet: boolean;
  hostEnvSet: boolean;
  fileBindCount: number;
}): boolean {
  return !input.flagBindSet && !input.okBindSet && input.hostEnvSet && input.fileBindCount > 1;
}

function parseHttpOriginFlag(flagName: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidArgumentError(`${flagName} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidArgumentError(`${flagName} must be an http(s) origin (got: ${value})`);
  }
  return value;
}

export function parseExternalUrlFlag(value: string): string {
  return parseHttpOriginFlag('--external-url', value);
}

const PROCESS_TITLE_PROJECT_NAME_MAX = 64;

export function deriveServerProcessTitle(cwd: string): string {
  const raw = basename(cwd);
  const sanitized = raw
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, PROCESS_TITLE_PROJECT_NAME_MAX);
  const projectName = sanitized.length > 0 ? sanitized : 'unknown';
  return `open-knowledge-server ${projectName}`;
}

export class GqDirMissingError extends Error {
  readonly cwd: string;
  constructor(cwd: string) {
    super(
      `This directory isn't set up yet. Run \`${currentCliCommandName()} init\` first, then \`${currentCliCommandName()} start\` again.`,
    );
    this.name = 'GqDirMissingError';
    this.cwd = cwd;
  }
}

export function withIdleShutdownProcessExit(
  handler: () => Promise<void>,
  deps: {
    log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
    exit?: (code: number) => void;
    getActiveHandles?: () => unknown[] | null;
  } = {},
): () => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const getActiveHandles =
    deps.getActiveHandles ??
    (() => {
      const probe = (process as unknown as { _getActiveHandles?: () => unknown[] })
        ._getActiveHandles;
      return probe ? probe.call(process) : null;
    });
  return async () => {
    let failed = false;
    try {
      await handler();
    } catch (err) {
      failed = true;
      deps.log?.error({ err }, 'idle-shutdown: destroy failed — exiting anyway');
    } finally {
      let handleSummary: Record<string, number> | null = null;
      try {
        const handles = getActiveHandles();
        if (handles !== null) {
          handleSummary = {};
          for (const handle of handles) {
            const name =
              (handle as { constructor?: { name?: string } } | null)?.constructor?.name ??
              'unknown';
            handleSummary[name] = (handleSummary[name] ?? 0) + 1;
          }
        }
      } catch {
        handleSummary = null;
      }
      deps.log?.info(
        {
          event: 'idle-shutdown-exit',
          exitCode: failed ? 1 : 0,
          openHandles: handleSummary ?? {},
          handlesAvailable: handleSummary !== null,
        },
        'idle-shutdown: teardown finished — exiting process',
      );
      exit(failed ? 1 : 0);
    }
  };
}

interface BootStartServerOptions {
  config: Config;
  cwd: string;
  host: string;
  port?: number;
  skipAutoInit?: boolean;
  idleThresholdMs?: number | null;
  serverRuntime?: ServerRuntimeConfig;
  bind?: readonly string[];
  idleExit?: (code: number) => void;
  log?: PinoLogger;
  serveContentAssets?: boolean;
  reactShellDistDir?: string;
}

export interface BootedStartServer {
  httpServer: HttpServer;
  destroy: (reason?: ServerExitReason, detail?: ServerExitDetail) => Promise<void>;
  lockDir: string;
  contentDir: string;
  port: number;
  ready: Promise<void>;
  degraded: readonly string[];
}

export async function bootStartServer(opts: BootStartServerOptions): Promise<BootedStartServer> {
  const { config, cwd, host } = opts;
  const skipAutoInit = opts.skipAutoInit ?? false;
  const idleThresholdMs =
    opts.idleThresholdMs === undefined ? DEFAULT_IDLE_THRESHOLD_MS : opts.idleThresholdMs;

  const { existsSync, mkdirSync } = await import('node:fs');
  const { bootServer, getLogger, resolveContentDir, resolveLockDir, waitForServerLockDrain } =
    await import('@gitquire/server');

  const log = opts.log ?? getLogger('start');

  if (!skipAutoInit && !isProjectRoot(cwd)) {
    throw new GqDirMissingError(cwd);
  }

  const contentDir = resolveContentDir(config, cwd);
  if (!existsSync(contentDir)) {
    mkdirSync(contentDir, { recursive: true });
    log.info({ contentDir }, 'Created content directory');
  }

  const tokenStore = makeLazyProbeTokenStore();
  const embeddingsKeyStore = makeLazyEmbeddingsKeyStore();

  {
    const drainLockDir = resolveLockDir(cwd);
    const drainWaitStartedAt = Date.now();
    const drainOutcome = await waitForServerLockDrain(drainLockDir);
    if (drainOutcome !== 'no-drain') {
      log.info(
        {
          event: 'start-waited-for-draining-predecessor',
          outcome: drainOutcome,
          waitedMs: Date.now() - drainWaitStartedAt,
          drainLockDir,
        },
        drainOutcome === 'released'
          ? '[start] predecessor server finished draining — proceeding'
          : '[start] predecessor server still draining after wait — proceeding to collide',
      );
    }
  }

  const booted: BootedServer = await bootServer({
    config,
    contentDir,
    projectDir: cwd,
    contentRoot: config.content.dir,
    port: opts.port,
    host,
    quiet: false,
    detectGh,
    detectGhAccounts,
    tokenStore,
    embeddingsKeyStore,
    localOpCliArgs: [process.execPath, process.argv[1]],
    idleShutdownMs: idleThresholdMs,
    ...(opts.serverRuntime !== undefined ? { serverRuntime: opts.serverRuntime } : {}),
    ...(opts.bind !== undefined ? { bind: opts.bind } : {}),
    skipAutoInit: true,
    idleShutdownHandler: (destroyServer) =>
      withIdleShutdownProcessExit(destroyServer, { log, exit: opts.idleExit }),
    log,
    ...(opts.serveContentAssets !== undefined
      ? { serveContentAssets: opts.serveContentAssets }
      : {}),
    ...(opts.reactShellDistDir ? { reactShellDistDir: opts.reactShellDistDir } : {}),
  });

  return {
    httpServer: booted.httpServer,
    destroy: booted.destroy,
    lockDir: booted.lockDir,
    contentDir,
    port: booted.port,
    ready: booted.ready,
    degraded: booted.degraded,
  };
}

interface StartCommandOptions {
  mode?: string;
  port?: string | number;
  bind?: string[];
  only?: OnlyModule;
  idleShutdown?: string;
  serveContentAssets?: boolean;
  reactShellDistDir?: string;
  externalUrl?: string;
}

export function resolveStartConsoleLevel(env: {
  GITQUIRE_CONSOLE_LEVEL?: string | undefined;
  LOG_LEVEL?: string | undefined;
}): string | null {
  if (env.GITQUIRE_CONSOLE_LEVEL !== undefined || env.LOG_LEVEL !== undefined) return null;
  return 'warn';
}

export function formatShutdownNotice(signal: NodeJS.Signals): string[] {
  const lines = [
    'Stopping GitQuire…',
    'Saving pending changes and releasing the server lock — this can take a few seconds.',
  ];
  if (signal === 'SIGINT') {
    lines.push('Press Ctrl+C again to force quit.');
  }
  return lines;
}

export async function runStartCommand(config: Config, opts: StartCommandOptions): Promise<void> {
  const startConsoleLevel = resolveStartConsoleLevel(process.env);
  if (startConsoleLevel !== null) process.env.GITQUIRE_CONSOLE_LEVEL = startConsoleLevel;

  const { renderBanner } = await import('../ui/banner.ts');
  const { accent, dim, error, warning } = await import('../ui/colors.ts');

  const cwd = process.cwd();

  process.title = deriveServerProcessTitle(cwd);

  let envLayer: EnvConfigLayer;
  try {
    envLayer = resolveEnvConfigLayer(process.env);
  } catch (err) {
    if (err instanceof EnvVarError) {
      console.error(error(err.message));
      process.exit(78);
    }
    throw err;
  }
  for (const diag of envLayer.diagnostics) {
    console.warn(warning(`[config] ${diag.message}`));
  }
  const envConfig = applyConfigOverlay(config, envLayer.layer) as Config;

  const okBindSet = envLayer.overrides.some((o) => o.envVar === 'GITQUIRE_BIND');
  const flagBind = opts.bind !== undefined && opts.bind.length > 0 ? opts.bind : undefined;
  const hostEnvRaw = process.env.HOST;
  const hostEnv = hostEnvRaw !== undefined && hostEnvRaw.trim() !== '' ? hostEnvRaw : undefined;
  const envFileRuntime = resolveServerRuntimeConfig(envConfig);
  const requestedBind =
    flagBind ?? (okBindSet || hostEnv === undefined ? [...envFileRuntime.bind] : [hostEnv]);

  if (
    shouldWarnHostOverridesMultiBind({
      flagBindSet: flagBind !== undefined,
      okBindSet,
      hostEnvSet: hostEnv !== undefined,
      fileBindCount: envFileRuntime.bind.length,
    })
  ) {
    console.warn(
      warning(
        `[config] HOST=${hostEnv} overrides server.bind — dropping the file-configured addresses (${envFileRuntime.bind.join(', ')}). Use GITQUIRE_BIND with a space-separated list to keep multiple binds.`,
      ),
    );
  }

  const host = requestedBind[0] ?? DEFAULT_SERVER_HOST;
  const bindList = requestedBind;
  const flagExternalUrl = opts.externalUrl;
  const runtime: ServerRuntimeConfig = resolveServerRuntimeConfig(
    applyConfigOverlay(envConfig, {
      server: {
        bind: bindList,
        ...(flagExternalUrl !== undefined ? { externalUrl: flagExternalUrl } : {}),
      },
    }) as Config,
  );

  if (runtime.allowExternal && (!runtime.loopbackOnly || runtime.externalUrl)) {
    const reach = runtime.externalUrl ?? runtime.bind.join(', ');
    console.warn(
      warning(
        [
          '',
          '⚠  EXTERNAL ACCESS ENABLED (server.allowExternal) — no server-side authentication.',
          `   This server is reachable beyond this machine (${reach}). Anyone who can`,
          '   reach it has FULL control of this knowledge base — sync, publishing, GitHub',
          '   credentials, and local operations (clone, sign-in, repo spawn).',
          '   Restrict who can reach it at the edge: a Tailscale ACL, a reverse proxy with',
          '   auth (Cloudflare Access, oauth2-proxy), or a firewall.',
          '',
        ].join('\n'),
      ),
    );
  }

  const portFromCli = opts.port !== undefined ? Number(opts.port) : undefined;
  const portFromEnv = envLayer.overrides.find((o) => o.envVar === 'PORT')?.value as
    | number
    | undefined;
  const port = portFromCli ?? portFromEnv ?? config.server?.port;

  const shell = resolveStartShellDir({
    explicitDir: opts.reactShellDistDir,
    only: opts.only,
    findBundledDir: resolveBundledReactShellDir,
  });
  const reactShellDistDir = shell.dir;
  if (shell.missingBundle) {
    console.warn(
      'bundled web UI not found — serving /api and /mcp only. Reinstall @gitquire/cli, or build packages/app in a source checkout.',
    );
  }

  let booted: BootedStartServer;
  try {
    booted = await bootStartServer({
      config,
      cwd,
      host,
      port,
      bind: bindList,
      ...(opts.serveContentAssets !== undefined
        ? { serveContentAssets: opts.serveContentAssets }
        : {}),
      ...(reactShellDistDir ? { reactShellDistDir } : {}),
      idleThresholdMs: idleShutdownToMs(opts.idleShutdown ?? runtime.idleShutdown),
      serverRuntime: runtime,
    });
  } catch (err) {
    if (err instanceof GqDirMissingError) {
      console.error(error(err.message));
      process.exit(1);
    }

    const serverModule = await import('@gitquire/server');
    if (
      err instanceof serverModule.GitNotAvailableError ||
      err instanceof serverModule.GitProbeTimeoutError ||
      err instanceof serverModule.GitTooOldError
    ) {
      process.exit(78);
    }

    if (
      err instanceof serverModule.ExposureConsentError ||
      err instanceof serverModule.GitHubAuthConfigError ||
      err instanceof serverModule.GitHubAppConfigError
    ) {
      console.error(error(err.message));
      process.exit(78);
    }

    if (
      err instanceof serverModule.MissingOkConfigError ||
      err instanceof serverModule.DocumentDurabilityStateError
    ) {
      console.error(error(err.message));
      process.exit(1);
    }

    if (isServerLockCollision(err, serverModule, cwd)) {
      const lockDir = serverModule.resolveLockDir(cwd);
      let reuse: ServerReuseInfo | null = null;
      try {
        reuse = await resolveServerReuse({
          readServerLock: () => serverModule.readServerLock(lockDir),
          now: Date.now,
          sleep: (ms) => wait(ms),
          timeoutMs: 3000,
          pollIntervalMs: 50,
        });
      } catch (reuseErr) {
        process.stderr.write(
          `[start] spawn-or-reuse: lock poll failed (${reuseErr instanceof Error ? reuseErr.message : String(reuseErr)}) — falling back to the collision message\n`,
        );
      }
      if (reuse !== null) {
        const [headline, ...rest] = formatServerReuseNotice(reuse);
        console.log(accent(headline));
        for (const line of rest) {
          console.log(dim(line));
        }
        process.exit(0);
      }
    }

    const tailored = tryDescribeLockCollision(err, cwd, serverModule);
    if (tailored !== null) {
      console.error(error(tailored));
      process.exit(1);
    }

    console.error(
      `${error('Failed to start:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const [headline, ...details] = formatShutdownNotice(signal);
    console.log(accent(`\n${headline}`));
    for (const line of details) {
      console.log(dim(`  ${line}`));
    }
    try {
      await booted.destroy('external-signal', { signal });
    } catch (err) {
      console.error(
        `${error('destroy() failed:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const apiUrl = `http://${urlHost}:${booted.port}`;
  const networkUrl =
    host === '0.0.0.0' || host === '::' ? `http://0.0.0.0:${booted.port}` : undefined;

  const localUrl = apiUrl;

  console.log(
    renderBanner({
      name: 'open-knowledge',
      version: PACKAGE_VERSION,
      localUrl,
      networkUrl,
      nextSteps: ['Open the Editor URL in your browser to start editing.'],
    }),
  );
  const DEGRADED_IMPACTS: Record<string, string> = {
    'shadow-repo': 'Version history and branch-switch safety unavailable',
    'file-watcher': 'External file changes will not sync to the editor',
  };
  booted.ready
    .then(async () => {
      if (booted.degraded.length > 0) {
        console.log();
        for (const id of booted.degraded) {
          const impact = DEGRADED_IMPACTS[id] ?? `${id} (check server logs for details)`;
          console.warn(`  ${warning('\u26a0')} ${warning(id)}: ${dim(impact)}`);
        }
        console.log();
      }
    })
    .catch((err) => {
      console.error(
        `  ${error('Server initialization failed:')} ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

export interface ServerReuseInfo {
  url: string;
  kind?: string | undefined;
  pid: number;
  servesUi: boolean;
}

interface ResolveServerReuseDeps {
  readServerLock: () => {
    pid: number;
    port: number;
    url?: string;
    kind?: string;
    draining?: boolean;
    capabilities?: string[];
  } | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
}

/**
 * All time + IO deps injected (precedent #13b) so tests drive every branch with a virtual clock and
 * no filesystem.
 */
export async function resolveServerReuse(
  deps: ResolveServerReuseDeps,
): Promise<ServerReuseInfo | null> {
  const deadline = deps.now() + deps.timeoutMs;
  let lock = deps.readServerLock();
  while (lock !== null && lock.draining !== true && lock.port <= 0 && deps.now() < deadline) {
    await deps.sleep(deps.pollIntervalMs);
    lock = deps.readServerLock();
  }
  if (lock === null || lock.draining === true || lock.port <= 0) return null;
  if (lockAdvertisesUi(lock) && lock.url !== undefined) {
    return { url: lock.url, kind: lock.kind, pid: lock.pid, servesUi: true };
  }
  return {
    url: lock.url ?? `http://${DEFAULT_SERVER_HOST}:${lock.port}`,
    kind: lock.kind,
    pid: lock.pid,
    servesUi: false,
  };
}

export function formatServerReuseNotice(info: ServerReuseInfo): string[] {
  const holder =
    info.kind === 'mcp-spawned'
      ? 'An MCP-spawned GitQuire server is already running on this project'
      : 'GitQuire is already running on this project';
  return [
    `${holder} (pid ${info.pid}).`,
    `  ${info.url}`,
    `Leaving it running — run \`${currentCliCommandName()} stop\` first if you want a fresh server.`,
  ];
}

export function isServerLockCollision(
  err: unknown,
  serverModule: typeof import('@gitquire/server'),
  cwd: string,
): boolean {
  const lockErr = serverModule.ServerLockCollisionError;
  if (lockErr !== undefined && err instanceof lockErr) return true;
  const authorityErr = serverModule.ServerAuthorityCollisionError;
  if (authorityErr === undefined || !(err instanceof authorityErr)) return false;
  try {
    return (
      err.existing.scope.kind === 'tree' && realpathSync.native(cwd) === err.existing.projectDir
    );
  } catch {
    return false;
  }
}

export function tryDescribeLockCollision(
  err: unknown,
  cwd: string,
  serverModule: typeof import('@gitquire/server'),
): string | null {
  const authorityErr = serverModule.ServerAuthorityCollisionError;
  if (authorityErr !== undefined && err instanceof authorityErr) return err.message;
  const registryErr = serverModule.ServerAuthorityRegistryError;
  if (registryErr !== undefined && err instanceof registryErr) return err.message;
  const lockFileErr = serverModule.ProcessLockFileError;
  if (lockFileErr !== undefined && err instanceof lockFileErr) return err.message;
  const lockErr = serverModule.ServerLockCollisionError;
  if (lockErr === undefined || !(err instanceof lockErr)) return null;

  try {
    const meta = serverModule.readServerLock(serverModule.resolveLockDir(cwd));
    const command = currentCliCommandName();
    if (meta?.kind === 'mcp-spawned') {
      return `An MCP-spawned server holds this lock; it should release on idle-shutdown (~30 min). Or run \`${command} stop\`.`;
    }
    return `GitQuire server is already running on this project — check \`${command} status\` or \`${command} stop\`.`;
  } catch {
    return null;
  }
}

export function startCommand(getConfig: () => Config): Command {
  const cmd = new Command('start')
    .description('Start the GitQuire server (UI + API + MCP + collab on one port)')
    .option('-p, --port <port>', 'Server port', undefined)
    .option(
      '--bind <address>',
      'Bind address (repeatable; default 127.0.0.1 — loopback only)',
      (value: string, prev: string[] | undefined) => [...(prev ?? []), value],
    )
    .option(
      '--only <module>',
      "Serve one module: 'server' (API + MCP only, no shell or browser)",
      parseOnlyModule,
    )
    .option(
      '--idle-shutdown <duration>',
      "Shut the server down after this long with no connected clients ('off', or a duration like 90s, 30m, 2h; default 30m)",
      parseIdleShutdownFlag,
    )
    .addOption(new Option('--mode <mode>').hideHelp())
    .option(
      '--serve-content-assets',
      'Serve content assets from this server (now the default; kept for compatibility)',
    )
    .option('--react-shell-dist-dir <path>', 'Serve React shell from <path>')
    .option(
      '--external-url <url>',
      'Canonical external origin clients dial (sets server.externalUrl for this run) — its host joins the Host/Origin allowlists (CORS + external-Host admission). External exposure additionally requires consent (GITQUIRE_ALLOW_EXTERNAL=1 or server.allowExternal).',
      parseExternalUrlFlag,
    )
    .action(async (opts: StartCommandOptions) => {
      const config = getConfig();

      if (opts.only === 'server' && opts.reactShellDistDir !== undefined) {
        process.stderr.write(
          "error: option '--only server' cannot be combined with '--react-shell-dist-dir'\n",
        );
        process.exit(2);
      }

      if (opts.mode === 'app') {
        process.stderr.write(
          "error: '--mode app' opened the desktop app, which GitQuire does not ship; run 'gq start' to serve the web editor\n",
        );
        process.exit(2);
      }

      await runStartCommand(config, opts);
    });

  return cmd;
}
