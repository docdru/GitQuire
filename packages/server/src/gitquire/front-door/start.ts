import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import { createAppJwt, GitHubUnavailableError, retryWhileUnavailable } from '../github-app.ts';
import type { DoorHost, HostPerson } from '../host/types.ts';
import { FRONT_DOOR_LOCK, interruptedMove } from '../volume-markers.ts';
import { createWikiAccess } from './access.ts';
import { addWikiHelpFor } from './add-wiki-help.ts';
import { createDoorAgents } from './agents.ts';
import { type AllowedOwners, ownerAllowed } from './allowed-owners.ts';
import {
  type DoorHostEntry,
  doorHostFor,
  doorHostPaths,
  doorHosts,
  trialKey,
} from './door-hosts.ts';
import { createForgejoTokenScopeCheck } from './forgejo-token-check.ts';
import type { HostSettings } from './hosts.ts';
import { createMentionCounts } from './mention-counts.ts';
import { openRepoTokenStore, repoTokenKey, repoTokensFile } from './repo-tokens.ts';
import { createFrontDoor, type ForgejoTokenChecks, RECHECK_MS } from './server.ts';
import {
  FrontDoorConfigError,
  type FrontDoorSettings,
  resolveFrontDoorSettings,
} from './settings.ts';
import { listenTokenSocket } from './token-socket.ts';
import { createWikiProcesses } from './wiki-processes.ts';
import { openWikiTable, type WikiRecord, wikiTableFile } from './wiki-table.ts';

type Env = Readonly<Record<string, string | undefined>>;

const WIKI_CHECK_MS = 10 * 60 * 1000;

interface RunningFrontDoor {
  server: Server;
  port: number;
  stop: () => Promise<void>;
}

export function refuseSingleWikiVolume(dataDir: string): void {
  const move = interruptedMove(dataDir);
  if (move !== undefined) {
    throw new FrontDoorConfigError(
      `${dataDir} is in the middle of "${move}", which was interrupted. Run "${move}" again to finish it before starting GitQuire.`,
    );
  }
  if (existsSync(join(dataDir, '.git'))) {
    throw new FrontDoorConfigError(
      `${dataDir} holds the checkout of a single wiki (it has .git). Move it into the several-wiki layout first with "gitquire wikis adopt" (see "Moving a single wiki over" in DEPLOY.md), or give the front door a volume of its own.`,
    );
  }
}

async function checkHost(host: DoorHost, log: GateLogger): Promise<void> {
  await retryWhileUnavailable(
    async () => {
      const result = await host.selfCheck();
      if (result.ok) return;
      if (result.unreachable) throw new GitHubUnavailableError(result.problems.join(' '));
      throw new FrontDoorConfigError(result.problems.join(' '));
    },
    {
      onRetry: (err, attempt, delayMs) =>
        log.warn({ attempt, delayMs, reason: err.message }, '[gitquire-door] host unavailable'),
    },
  );
}

export async function startFrontDoor(
  dataDir: string,
  env: Env,
  options: { log: GateLogger; cli: readonly string[] },
): Promise<RunningFrontDoor> {
  const log = options.log;
  const settings: FrontDoorSettings = resolveFrontDoorSettings(env, dataDir);
  if ((env.GITQUIRE_HOST_REPO_TOKEN ?? env.GITQUIRE_HOST_REPO_TOKEN_FILE ?? '').trim() !== '') {
    log.warn(
      {},
      "[gitquire-door] GITQUIRE_HOST_REPO_TOKEN is not used with GITQUIRE_WIKIS=on; a server administrator enters each wiki's token when adding it",
    );
  }
  refuseSingleWikiVolume(settings.dataDir);
  mkdirSync(join(settings.dataDir, 'server'), { recursive: true, mode: 0o700 });
  chmodSync(join(settings.dataDir, 'server'), 0o700);
  mkdirSync(join(settings.dataDir, 'wikis'), { recursive: true });
  const table = openWikiTable(wikiTableFile(settings.dataDir));
  const tokenFile = repoTokensFile(settings.dataDir);
  const later = { check: (_wiki: WikiRecord): void => {} };

  function entryFor(hostSettings: HostSettings): DoorHostEntry {
    const key = hostSettings.key;
    const owners: AllowedOwners = hostSettings.primary
      ? { names: hostSettings.allowedOwners, pinned: table.ownerIds, pin: table.pinOwner }
      : {
          names: hostSettings.allowedOwners,
          pinned: () => table.hostOwnerIds(key),
          pin: (owner, id) => table.pinHostOwner(key, owner, id),
        };
    const trial = new Map<string, string>();
    const store =
      hostSettings.kind === 'forgejo'
        ? openRepoTokenStore(tokenFile, repoTokenKey(table, key))
        : undefined;
    const host = doorHostFor(
      hostSettings,
      (repo) => trial.get(trialKey(repo)) ?? store?.tokenFor(repo),
    );
    const access = createWikiAccess({
      host,
      ttlMs: settings.accessCheckMs,
      changed: (wiki) => later.check(wiki),
      runnable: (wiki) => ownerAllowed(owners, wiki),
      refused: (wiki, refusal) => {
        log.warn(
          { wiki: wiki.key, refusal },
          "[gitquire-door] GitQuire's access was refused: wiki disconnected",
        );
        table.disconnect(wiki.key, refusal);
      },
    });
    const tokenScope = createForgejoTokenScopeCheck({
      apiUrl: hostSettings.apiUrl,
      botToken: () => hostSettings.forgejoBotToken,
    });
    const forgejoTokens: ForgejoTokenChecks | undefined =
      store === undefined
        ? undefined
        : {
            check: async (repo, token) => {
              trial.set(trialKey(repo), token);
              let health: Awaited<ReturnType<DoorHost['health']>>;
              try {
                health = await host.health(repo);
              } finally {
                trial.delete(trialKey(repo));
              }
              if (health !== 'ok') return health;
              const scope = await tokenScope(repo, token);
              return scope === 'limited' ? 'ok' : scope;
            },
            save: store.set,
            forget: store.forget,
            isBotToken: (token) => token === hostSettings.forgejoBotToken,
          };
    const jwt = (): string => {
      const app = hostSettings.githubApp;
      if (app === undefined) throw new Error('No GitHub App key.');
      return createAppJwt(app.appId, app.privateKeyPem, Date.now());
    };
    return {
      key,
      settings: hostSettings,
      names: hostSettings.names,
      host,
      access,
      owners,
      paths: doorHostPaths(key),
      ...(forgejoTokens === undefined ? {} : { forgejoTokens }),
      addWikiHelp: addWikiHelpFor({
        host,
        kind: hostSettings.kind,
        apiUrl: hostSettings.apiUrl,
        jwt,
        botToken: () => hostSettings.forgejoBotToken,
      }),
    };
  }

  const hosts = doorHosts(settings.hosts.map(entryFor));
  await checkHost(hosts.primary.host, log);
  for (const further of hosts.list().slice(1)) {
    further.host
      .selfCheck()
      .then((result) => {
        if (!result.ok) {
          log.warn(
            { host: further.key, unreachable: result.unreachable, problems: result.problems },
            '[gitquire-door] a further host did not pass its start check; its wikis stay closed until it does',
          );
        }
      })
      .catch((err: unknown) =>
        log.warn({ err, host: further.key }, '[gitquire-door] a further host could not be checked'),
      );
  }

  let tokenSocketPath = '';
  const processes = createWikiProcesses({
    dataDir: settings.dataDir,
    externalUrl: settings.externalUrl,
    env,
    cli: options.cli,
    hostOf: (wiki) => {
      const entry = hosts.of(wiki);
      return entry === undefined
        ? undefined
        : { host: entry.host, owners: entry.owners, settings: entry.settings };
    },
    table,
    tokenSocket: () => tokenSocketPath,
    idleMs: settings.wikiIdleMs,
    log,
  });
  later.check = (wiki) => {
    processes
      .check(wiki)
      .catch((err: unknown) =>
        log.warn({ err, wiki: wiki.key }, '[gitquire-door] wiki check failed'),
      );
  };
  const tokenSocket = await listenTokenSocket({
    wikiOfSecret: processes.wikiOfSecret,
    repoOf: (key) => {
      const wiki = table.byKey(key);
      return wiki === undefined || wiki.state !== 'on' ? undefined : wiki;
    },
    tokenFor: (repo, key) => {
      const wiki = table.byKey(key);
      const entry = wiki === undefined ? undefined : hosts.of(wiki);
      return entry === undefined ? Promise.resolve(undefined) : entry.host.tokenFor(repo);
    },
    log,
  });
  tokenSocketPath = tokenSocket.path;

  let doorSessionUser: (req: IncomingMessage) => HostPerson | undefined = () => undefined;
  const agents = createDoorAgents({
    settings,
    hosts,
    table,
    processes,
    sessionUser: (req) => doorSessionUser(req),
    log,
  });
  agents.sweep.runOnce().catch((err: unknown) => {
    log.warn({ err }, '[gitquire-agents] initial access check failed');
  });
  const door = createFrontDoor({
    settings,
    hosts,
    table,
    processes,
    agents,
    mentionCounts: createMentionCounts(settings.dataDir),
    log,
  });
  doorSessionUser = door.sessionUser;
  if (settings.mcpConnectors && settings.externalUrl.protocol !== 'https:') {
    log.warn(
      { externalUrl: settings.externalUrl.toString() },
      '[gitquire-door] GITQUIRE_MCP_CONNECTORS is on, but Claude and other cloud connectors need an https:// GITQUIRE_EXTERNAL_URL',
    );
  }
  const server = createServer(door.handleRequest);
  server.on('upgrade', door.handleUpgrade);
  const port = Number(env.PORT ?? '') || 8080;
  const bind = (env.GITQUIRE_BIND ?? '').trim() || '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolve());
  });
  const lockFile = join(settings.dataDir, 'server', FRONT_DOOR_LOCK);
  writeFileSync(
    lockFile,
    `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  const recheck = setInterval(
    () => {
      door
        .recheckConnections()
        .catch((err: unknown) => log.warn({ err }, '[gitquire-door] live-editing re-check failed'));
    },
    Math.min(RECHECK_MS, settings.accessCheckMs),
  );
  recheck.unref();
  const checkAll = async (): Promise<void> => {
    for (const wiki of table.list()) {
      await processes
        .check(wiki)
        .catch((err: unknown) =>
          log.warn({ err, wiki: wiki.key }, '[gitquire-door] wiki check failed'),
        );
    }
  };
  void checkAll();
  const checks = setInterval(() => {
    void checkAll();
  }, WIKI_CHECK_MS);
  checks.unref();

  door.setReady(true);
  log.info(
    {
      port: boundPort,
      host: settings.host,
      ...(hosts.list().length > 1 ? { hosts: hosts.list().map((entry) => entry.key) } : {}),
      wikis: table.list().length,
      allowedOwners: [...settings.allowedOwners],
    },
    '[gitquire-door] front door started',
  );

  return {
    server,
    port: boundPort,
    stop: async () => {
      door.setReady(false);
      clearInterval(recheck);
      clearInterval(checks);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await agents.close();
      await processes.stopAll();
      await tokenSocket.close();
      rmSync(lockFile, { force: true });
    },
  };
}
