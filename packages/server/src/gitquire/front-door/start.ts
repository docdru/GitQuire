import { chmodSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import { deriveChatKeySecret, derivePeopleKeySecret } from '../chat/key-secret.ts';
import { createAppJwt } from '../github-app.ts';
import type { DoorHost, HostPerson } from '../host/types.ts';
import { isSameOriginRequest } from '../http-util.ts';
import { resolveMailConfig, sendMail } from '../mail.ts';
import { personChatData, personKeyStore } from '../people/chat-data.ts';
import { createEmailService } from '../people/email-service.ts';
import { createPeopleMailer, forgetWikiMailed, openWithin } from '../people/mailer.ts';
import { movePeopleData } from '../people/move-over.ts';
import { createPersonRoutes, emailRoutes, settingsRoutes } from '../people/person-routes.ts';
import { personSettings } from '../people/settings.ts';
import { createPeopleStore, frontDoorPeopleRoot } from '../people/store.ts';
import { createPersonTickets } from '../people/ticket.ts';
import { singleWikiMarker } from '../volume-markers.ts';
import { createWikiAccess } from './access.ts';
import { accountAddressReader } from './account-addresses.ts';
import { addWikiHelpFor } from './add-wiki-help.ts';
import { createDoorAgents } from './agents.ts';
import { type AllowedOwners, ownerAllowed } from './allowed-owners.ts';
import { BRANCH_WATCH_MS, createBranchWatch } from './branch-watch.ts';
import {
  type DoorHostEntry,
  doorHostFor,
  doorHostPaths,
  doorHosts,
  trialKey,
} from './door-hosts.ts';
import { createForgejoTokenScopeCheck } from './forgejo-token-check.ts';
import { checkHosts, hostSummary, warnUnknownNames } from './host-checks.ts';
import type { HostSettings } from './hosts.ts';
import { createMentionCounts } from './mention-counts.ts';
import { createPersonSocketHandler } from './person-socket.ts';
import { openRepoTokenFile, repoTokenKey, repoTokensFile } from './repo-tokens.ts';
import { createFrontDoor, type ForgejoTokenChecks, RECHECK_MS } from './server.ts';
import {
  FrontDoorConfigError,
  type FrontDoorSettings,
  FrontDoorSetupNeeded,
  resolveFrontDoorSettings,
} from './settings.ts';
import { createSetupServer } from './setup-page.ts';
import { listenTokenSocket } from './token-socket.ts';
import { createWikiProcesses } from './wiki-processes.ts';
import {
  openWikiTable,
  type WikiRecord,
  wikiDir,
  wikiName,
  wikiPrefix,
  wikiTableFile,
} from './wiki-table.ts';

type Env = Readonly<Record<string, string | undefined>>;

const WIKI_CHECK_MS = 10 * 60 * 1000;
const MAIL_ROUND_MS = 60 * 1000;

function branchWatchMs(env: Env): number {
  const seconds = Number(env.GITQUIRE_BRANCH_WATCH_SECONDS ?? '');
  return Number.isInteger(seconds) && seconds >= 10 ? seconds * 1000 : BRANCH_WATCH_MS;
}
const MAIL_ACCESS_DEADLINE_MS = 15 * 1000;

interface RunningFrontDoor {
  server: Server;
  port: number;
  stop: () => Promise<void>;
}

export function refuseSingleWikiVolume(dataDir: string): void {
  const marker = singleWikiMarker(dataDir);
  if (marker === undefined) return;
  throw new FrontDoorConfigError(
    `${dataDir} is a volume of the single-wiki mode (it has ${marker}), which no longer exists. Nothing on it was changed. The pages are in the Git repository: start GitQuire with a new, empty volume and add the wiki in the app (see "Upgrading from a single wiki" in DEPLOY.md). Keep this volume aside until you are sure.`,
  );
}

async function listen(server: Server, env: Env): Promise<number> {
  const port = Number(env.PORT ?? '') || 8080;
  const bind = (env.GITQUIRE_BIND ?? '').trim() || '127.0.0.1';
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => done());
  });
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : port;
}

async function startSetupPage(
  needed: FrontDoorSetupNeeded,
  env: Env,
  log: GateLogger,
): Promise<RunningFrontDoor> {
  const server = createSetupServer(needed);
  const port = await listen(server, env);
  log.warn(
    { port, missing: needed.missing },
    '[gitquire-door] not set up yet: every address shows the set-up page until these settings are given',
  );
  return {
    server,
    port,
    stop: async () => {
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}

export async function startFrontDoor(
  dataDir: string,
  env: Env,
  options: { log: GateLogger; cli: readonly string[] },
): Promise<RunningFrontDoor> {
  const log = options.log;
  refuseSingleWikiVolume(resolve(dataDir));
  let settings: FrontDoorSettings;
  try {
    settings = resolveFrontDoorSettings(env, dataDir);
  } catch (err) {
    if (!(err instanceof FrontDoorSetupNeeded)) throw err;
    return startSetupPage(err, env, log);
  }
  mkdirSync(join(settings.dataDir, 'server'), { recursive: true, mode: 0o700 });
  chmodSync(join(settings.dataDir, 'server'), 0o700);
  mkdirSync(join(settings.dataDir, 'wikis'), { recursive: true });
  const table = openWikiTable(wikiTableFile(settings.dataDir));
  const tokenFile = openRepoTokenFile(repoTokensFile(settings.dataDir));
  const later = { check: (_wiki: WikiRecord): void => {} };

  function entryFor(hostSettings: HostSettings): DoorHostEntry {
    const key = hostSettings.key;
    const owners: AllowedOwners = { names: hostSettings.allowedOwners, ...table.pinsOn(key) };
    const trial = new Map<string, string>();
    const store =
      hostSettings.kind === 'forgejo' ? tokenFile.scoped(repoTokenKey(table, key)) : undefined;
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
  for (const entry of hosts.list()) {
    log.info(hostSummary(entry, settings.externalUrl), '[gitquire-door] host');
  }
  await checkHosts(hosts.list(), log);
  void warnUnknownNames(hosts.list(), log);

  const tickets = createPersonTickets();
  const people = createPeopleStore(frontDoorPeopleRoot(settings.dataDir));
  const personKeys = personKeyStore(people, derivePeopleKeySecret(settings.sessionSecret));
  const chatData = personChatData(people, personKeys);
  const usagePurge = setInterval(
    () => {
      try {
        chatData.purgeUsage(new Date());
      } catch (err) {
        log.warn({ err }, '[gitquire-chat] could not remove expired usage');
      }
    },
    6 * 60 * 60 * 1000,
  );
  usagePurge.unref();
  chatData.purgeUsage(new Date());
  const personSocket = createPersonSocketHandler({
    tickets,
    handlers: [chatData.answer],
    mayAsk: async (wikiKey, person, login) => {
      const wiki = table.byKey(wikiKey);
      const entry = wiki === undefined ? undefined : hosts.of(wiki);
      if (wiki === undefined || entry === undefined) return false;
      if (!person.startsWith(entry.names.idPrefix)) return false;
      const id = Number(person.slice(entry.names.idPrefix.length));
      return (await entry.access.decide({ id, login }, wiki)).open;
    },
    settings: personSettings(people),
    log,
  });
  const mail = resolveMailConfig(env);
  if (mail.kind === 'invalid') {
    log.warn({ reason: mail.reason }, '[gitquire-mail] email for mentions is off');
  }
  const email = createEmailService({
    store: people,
    countersFile: join(settings.dataDir, 'server', 'mail-recipients.json'),
    mail,
    codeKey: () => settings.sessionSecret,
    send: sendMail,
    log,
    onSwitchedOn: (person, login) => mailer.markExisting(person, login),
  });
  const mentionCounts = createMentionCounts(settings.dataDir);
  const mailer = createPeopleMailer({
    store: people,
    config: mail.kind === 'on' ? mail.config : undefined,
    send: sendMail,
    log,
    wikis: () =>
      table.list().flatMap((wiki) => {
        const entry = hosts.of(wiki);
        if (entry === undefined) return [];
        return [
          {
            key: wiki.key,
            idPrefix: entry.names.idPrefix,
            name: wikiName(wiki),
            url: `${settings.externalUrl.origin}${wikiPrefix(wiki)}`,
            mentions: () => mentionCounts.mentionsOf(wiki, entry.names.idPrefix),
            readIds: (id: number) => mentionCounts.readIdsOf(wiki, id),
            addedAt: wiki.addedAt,
            canOpen: (account: { id: number; login: string }) =>
              openWithin(
                entry.access.decide(account, wiki, { strict: true }),
                MAIL_ACCESS_DEADLINE_MS,
              ),
          },
        ];
      }),
  });
  let moved: ReturnType<typeof movePeopleData> = {
    wikis: [],
    failed: [],
    people: 0,
    addresses: 0,
    keys: 0,
    unreadableKeys: 0,
  };
  try {
    moved = movePeopleData(
      table.list().flatMap((wiki) => {
        const entry = hosts.of(wiki);
        return entry === undefined
          ? []
          : [
              {
                dir: wikiDir(settings.dataDir, wiki),
                wikiKey: wiki.key,
                idPrefix: entry.names.idPrefix,
                keySecrets: [
                  deriveChatKeySecret(settings.sessionSecret, wiki.key),
                  settings.sessionSecret,
                ],
              },
            ];
      }),
      {
        store: people,
        keys: personKeys,
        markExisting: (person, login, wikiKey, before) =>
          mailer.markExisting(person, login, wikiKey, before),
        wikiKeys: () => table.list().map((wiki) => wiki.key),
      },
    );
  } catch (err) {
    log.warn(
      { err },
      '[gitquire-people] could not move per-person data; tried again at the next start',
    );
  }
  if (moved.failed.length > 0) {
    log.warn(
      { wikis: moved.failed },
      '[gitquire-people] could not move the per-person data of these wikis; tried again at the next start',
    );
  }
  if (moved.wikis.length > 0) {
    log.info(
      {
        wikis: moved.wikis,
        people: moved.people,
        addresses: moved.addresses,
        keys: moved.keys,
        unreadableKeys: moved.unreadableKeys,
      },
      '[gitquire-people] moved per-person data of these wikis to the front door; the old files stay as they were',
    );
  }
  const mailRounds = setInterval(() => {
    mailer.round().catch((err: unknown) => log.warn({ err }, '[gitquire-mail] mail round failed'));
  }, MAIL_ROUND_MS);
  mailRounds.unref();
  const branchWatch = createBranchWatch({
    wikis: () => table.list(),
    isRunning: (key) => processes.isRunning(key),
    dirOf: (wiki) => wikiDir(settings.dataDir, wiki),
    gitHostOf: (wiki) => {
      const entry = hosts.of(wiki);
      return entry === undefined ? undefined : new URL(entry.settings.webUrl).host;
    },
    tokenFor: async (wiki) => hosts.of(wiki)?.host.tokenFor(wiki),
    wake: async (wiki) => {
      await processes.ensure(wiki);
    },
    intervalMs: branchWatchMs(env),
    log,
  });
  const branchRounds = setInterval(() => {
    branchWatch
      .round()
      .catch((err: unknown) => log.warn({ err }, '[gitquire-wikis] branch check failed'));
  }, branchWatchMs(env));
  branchRounds.unref();
  const personRoutes = createPersonRoutes({
    routes: [emailRoutes(email), settingsRoutes(personSettings(people))],
    sameOrigin: (req) => isSameOriginRequest(req, settings.externalUrl),
    log,
  });
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
    person: personSocket,
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
    contentsOf: (repo, key) => {
      const wiki = table.byKey(key);
      const entry = wiki === undefined ? undefined : hosts.of(wiki);
      return entry?.host.contentsOf?.(repo);
    },
    log,
  });
  tokenSocketPath = tokenSocket.path;

  let doorSessionUser: (req: IncomingMessage, hostKey: string) => HostPerson | undefined = () =>
    undefined;
  const agents = createDoorAgents({
    settings,
    hosts,
    table,
    processes,
    sessionUser: (req, hostKey) => doorSessionUser(req, hostKey),
    tickets,
    agentMode: (person) => personSettings(people).agentMode(person),
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
    mentionCounts,
    tickets,
    readAccountAddress: accountAddressReader({ store: people, log }),
    seen: (person, login) => email.seen({ person, login }),
    wikiRemoved: (key) => forgetWikiMailed(people, key),
    personRoutes,
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
  const boundPort = await listen(server, env);

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
      hosts: hosts.list().map((entry) => entry.key),
      wikis: table.list().length,
    },
    '[gitquire-door] front door started',
  );

  return {
    server,
    port: boundPort,
    stop: async () => {
      door.setReady(false);
      clearInterval(recheck);
      clearInterval(mailRounds);
      clearInterval(usagePurge);
      clearInterval(branchRounds);
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
