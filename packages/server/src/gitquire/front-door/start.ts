import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import { createAppJwt, GitHubUnavailableError, retryWhileUnavailable } from '../github-app.ts';
import { createForgejoDoorHost } from '../host/forgejo.ts';
import { createGitHubDoorHost } from '../host/github.ts';
import { hostNamesFromEnv, setHostNames } from '../host/names.ts';
import type { DoorHost, HostRepo } from '../host/types.ts';
import { createWikiAccess } from './access.ts';
import { addWikiHelpFor } from './add-wiki-help.ts';
import { type AllowedOwners, ownerAllowed } from './allowed-owners.ts';
import { openRepoTokenStore, repoTokensFile } from './repo-tokens.ts';
import { createFrontDoor, type ForgejoTokenChecks, RECHECK_MS } from './server.ts';
import {
  FrontDoorConfigError,
  type FrontDoorSettings,
  resolveFrontDoorSettings,
} from './settings.ts';
import { listenTokenSocket } from './token-socket.ts';
import { createWikiProcesses } from './wiki-processes.ts';
import { openWikiTable, wikiTableFile } from './wiki-table.ts';

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
  mkdirSync(join(settings.dataDir, 'server'), { recursive: true, mode: 0o700 });
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

  const appJwt = (): string => {
    const app = settings.githubApp;
    if (app === undefined) throw new Error('No GitHub App key.');
    return createAppJwt(app.appId, app.privateKeyPem, Date.now());
  };
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
            app: { jwt: appJwt },
          },
        );
  await checkHost(host, log);

  const access = createWikiAccess({
    host,
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

  const forgejoTokens: ForgejoTokenChecks | undefined =
    store === undefined
      ? undefined
      : {
          check: async (repo, token) => {
            trial.set(nameKey(repo), token);
            try {
              return await host.health(repo);
            } finally {
              trial.delete(nameKey(repo));
            }
          },
          save: store.set,
          isBotToken: (token) => token === settings.forgejoBotToken,
        };

  const door = createFrontDoor({
    settings,
    host,
    table,
    owners,
    access,
    processes,
    forgejoTokens,
    addWikiHelp: addWikiHelpFor({
      host,
      kind: settings.host,
      apiUrl: settings.apiUrl,
      jwt: appJwt,
      botToken: () => settings.forgejoBotToken,
    }),
    log,
  });
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
      await processes.stopAll();
      await tokenSocket.close();
    },
  };
}
