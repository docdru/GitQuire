import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import { createAppJwt, GitHubUnavailableError, retryWhileUnavailable } from '../github-app.ts';
import { createForgejoDoorHost } from '../host/forgejo.ts';
import { createGitHubDoorHost } from '../host/github.ts';
import { hostNamesFromEnv, setHostNames } from '../host/names.ts';
import type { DoorHost, HostPerson, HostRepo } from '../host/types.ts';
import { createWikiAccess } from './access.ts';
import { createDoorAgents } from './agents.ts';
import { type AllowedOwners, ownerAllowed } from './allowed-owners.ts';
import { createForgejoTokenScopeCheck } from './forgejo-token-check.ts';
import { openRepoTokenStore, repoTokensFile } from './repo-tokens.ts';
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

function nameKey(repo: HostRepo): string {
  return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
}

export function refuseSingleWikiVolume(dataDir: string): void {
  if (existsSync(join(dataDir, '.git'))) {
    throw new FrontDoorConfigError(
      `${dataDir} holds the checkout of a single wiki (it has .git). GITQUIRE_WIKIS=on needs a volume of its own; moving a single-wiki volume over is not supported yet.`,
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
  setHostNames(hostNamesFromEnv(env));
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
  const owners: AllowedOwners = {
    names: settings.allowedOwners,
    pinned: table.ownerIds,
    pin: table.pinOwner,
  };
  const trial = new Map<string, string>();
  const store =
    settings.host === 'forgejo'
      ? openRepoTokenStore(repoTokensFile(settings.dataDir), (repo) => {
          const match = table.byAddress(repo.owner, repo.name);
          return match?.current === true ? match.wiki.key : undefined;
        })
      : undefined;

  const host: DoorHost =
    settings.host === 'forgejo'
      ? createForgejoDoorHost(
          { webUrl: settings.webUrl, apiUrl: settings.apiUrl, repo: undefined },
          {
            botToken: () => settings.forgejoBotToken,
            repoTokens: {
              tokenFor: (repo) => trial.get(nameKey(repo)) ?? store?.tokenFor(repo),
            },
          },
        )
      : createGitHubDoorHost(
          { webUrl: settings.webUrl, apiUrl: settings.apiUrl, repo: undefined },
          {
            app: {
              jwt: () => {
                const app = settings.githubApp;
                if (app === undefined) throw new Error('No GitHub App key.');
                return createAppJwt(app.appId, app.privateKeyPem, Date.now());
              },
            },
          },
        );
  await checkHost(host, log);

  const later = { check: (_wiki: WikiRecord): void => {} };
  const access = createWikiAccess({
    host,
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

  let tokenSocketPath = '';
  const processes = createWikiProcesses({
    dataDir: settings.dataDir,
    externalUrl: settings.externalUrl,
    env,
    cli: options.cli,
    host,
    table,
    owners,
    tokenSocket: () => tokenSocketPath,
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
    tokenFor: host.tokenFor,
    log,
  });
  tokenSocketPath = tokenSocket.path;

  const tokenScope = createForgejoTokenScopeCheck({
    apiUrl: settings.apiUrl,
    botToken: () => settings.forgejoBotToken,
  });
  const forgejoTokens: ForgejoTokenChecks | undefined =
    store === undefined
      ? undefined
      : {
          check: async (repo, token) => {
            trial.set(nameKey(repo), token);
            let health: Awaited<ReturnType<DoorHost['health']>>;
            try {
              health = await host.health(repo);
            } finally {
              trial.delete(nameKey(repo));
            }
            if (health !== 'ok') return health;
            const scope = await tokenScope(repo, token);
            return scope === 'limited' ? 'ok' : scope;
          },
          save: store.set,
          isBotToken: (token) => token === settings.forgejoBotToken,
        };

  let doorSessionUser: (req: IncomingMessage) => HostPerson | undefined = () => undefined;
  const agents = createDoorAgents({
    settings,
    table,
    access,
    processes,
    sessionUser: (req) => doorSessionUser(req),
    log,
  });
  agents.sweep.runOnce().catch((err: unknown) => {
    log.warn({ err }, '[gitquire-agents] initial access check failed');
  });
  const door = createFrontDoor({
    settings,
    host,
    table,
    owners,
    access,
    processes,
    forgejoTokens,
    agents,
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
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  const recheck = setInterval(() => {
    door
      .recheckConnections()
      .catch((err: unknown) => log.warn({ err }, '[gitquire-door] live-editing re-check failed'));
  }, RECHECK_MS);
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
    },
  };
}
