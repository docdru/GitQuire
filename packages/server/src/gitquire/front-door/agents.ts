import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import { type AccessSweep, type AccessVerdict, startAccessSweep } from '../agent-access.ts';
import { AGENTS_PAGE_PATH, createAgentPages } from '../agent-pages.ts';
import { type AgentTokenStore, createAgentTokenStore } from '../agent-tokens.ts';
import { bearerToken, sendJson } from '../http-util.ts';
import { createOAuthServer, type OAuthServer } from '../oauth-server.ts';
import type { PersonTickets } from '../people/ticket.ts';
import { encodeAgentFeatures } from '../request-person.ts';
import type { DoorPerson } from './access.ts';
import { type DoorHostEntry, type DoorHosts, personIdOn } from './door-hosts.ts';
import { createDoorMcp, type DoorMcp } from './mcp.ts';
import type { FrontDoorSettings } from './settings.ts';
import type { WikiProcesses } from './wiki-processes.ts';
import type { WikiRecord, WikiTable } from './wiki-table.ts';

export interface DoorAgentsDeps {
  settings: Pick<
    FrontDoorSettings,
    'dataDir' | 'externalUrl' | 'sessionSecret' | 'agentTokenDays' | 'mcpConnectors'
  >;
  hosts: DoorHosts;
  table: Pick<WikiTable, 'list' | 'byAddress'>;
  processes: Pick<WikiProcesses, 'ensure' | 'touch' | 'secretOf'>;
  sessionUser: (req: IncomingMessage, hostKey: string) => SessionUser | undefined;
  tickets?: PersonTickets;
  agentMode?: (person: string) => 'live' | 'draft';
  log: GateLogger;
  stores?: ReadonlyMap<string, AgentTokenStore>;
  sweepMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface HostAgentPaths {
  agents: string;
  mcp: string;
}

export interface DoorAgents {
  handle: (req: IncomingMessage, res: ServerResponse, path: string, search: string) => boolean;
  features: (hostKey: string, person: DoorPerson) => string;
  pathsFor: (hostKey: string) => HostAgentPaths | undefined;
  verdict: (person: DoorPerson, hostKey?: string) => Promise<AccessVerdict>;
  store: AgentTokenStore;
  storeOf: (hostKey: string) => AgentTokenStore | undefined;
  sweep: AccessSweep;
  close: () => Promise<void>;
}

interface HostAgents {
  entry: DoorHostEntry;
  paths: HostAgentPaths;
  store: AgentTokenStore;
  sweep: AccessSweep;
  verdict: (person: DoorPerson) => Promise<AccessVerdict>;
  pages: ReturnType<typeof createAgentPages>;
  oauth: OAuthServer | undefined;
  mcp: DoorMcp;
}

export function agentTokensFile(dataDir: string, hostKey: string): string {
  return join(dataDir, 'server', `agent-tokens-${hostKey}.json`);
}

export function hostAgentPaths(hostKey: string): HostAgentPaths {
  return { agents: `/auth/${hostKey}/agents`, mcp: `/mcp/${hostKey}` };
}

function hostTable(
  table: DoorAgentsDeps['table'],
  hosts: DoorHosts,
  entry: DoorHostEntry,
): DoorAgentsDeps['table'] {
  const mine = (wiki: WikiRecord) => hosts.of(wiki) === entry;
  return {
    list: () => table.list().filter(mine),
    byAddress: (hostKey, owner, name) => {
      const match = hostKey === entry.key ? table.byAddress(hostKey, owner, name) : undefined;
      return match !== undefined && mine(match.wiki) ? match : undefined;
    },
  };
}

export function createDoorAgents(deps: DoorAgentsDeps): DoorAgents {
  const { settings, hosts, log } = deps;
  const primary = hosts.primary;
  const severalHosts = hosts.list().length > 1;

  function partFor(entry: DoorHostEntry): HostAgents {
    const paths = hostAgentPaths(entry.key);
    const table = hostTable(deps.table, hosts, entry);
    const sessionUser = (req: IncomingMessage) => deps.sessionUser(req, entry.key);
    const store =
      deps.stores?.get(entry.key) ??
      createAgentTokenStore({ file: agentTokensFile(settings.dataDir, entry.key), log });
    const access = {
      decide: (person: DoorPerson, wiki: WikiRecord) =>
        hosts.of(wiki) === entry
          ? entry.access.decide(person, wiki)
          : Promise.resolve({ open: false as const, why: 'no-access' as const }),
      wasAdmin: (person: DoorPerson, wiki: WikiRecord) =>
        hosts.of(wiki) === entry && entry.access.wasAdmin(person, wiki),
    };

    async function verdict(person: DoorPerson): Promise<AccessVerdict> {
      let unknown = false;
      for (const wiki of table.list()) {
        const decision = await access.decide(person, wiki);
        if (decision.open) return 'allowed';
        if (decision.why === 'unreachable') unknown = true;
      }
      return unknown ? 'unknown' : 'denied';
    }

    const sweep = startAccessSweep(store, (login, id) => verdict({ id, login }), {
      log,
      intervalMs: deps.sweepMs,
      reason: `[gitquire-agents] revoked agent access: the person has no wiki left on ${entry.names.label} on this server`,
    });

    const hostLabel = { label: entry.names.label, signInPath: entry.paths.login };
    const pages = createAgentPages({
      config: {
        externalUrl: settings.externalUrl,
        agentTokenDays: settings.agentTokenDays,
        admins: entry.settings.serverAdmins,
      },
      host: hostLabel,
      store,
      log,
      sessionUser,
      connectorsEnabled: settings.mcpConnectors,
      severalWikis: true,
      pagePath: paths.agents,
      mcpPath: paths.mcp,
      otherHosts: severalHosts
        ? hosts
            .list()
            .filter((other) => other !== entry)
            .map((other) => ({
              label: other.names.label,
              path: hostAgentPaths(other.key).agents,
            }))
        : undefined,
      now: deps.now,
    });

    const oauth: OAuthServer | undefined = settings.mcpConnectors
      ? createOAuthServer({
          externalUrl: settings.externalUrl,
          secret: settings.sessionSecret,
          store,
          log,
          sessionUser,
          checkAccess: (login, id) => verdict({ id, login }),
          host: hostLabel,
          hostKey: entry.key,
          agentsPagePath: paths.agents,
          severalWikis: true,
          refuseUnknownAtSignIn: true,
          fetch: deps.fetch,
          now: deps.now,
        })
      : undefined;

    const tickets = deps.tickets;
    const mcp = createDoorMcp({
      externalUrl: settings.externalUrl,
      table,
      access,
      processes: deps.processes,
      seesWhy: (person, wiki) =>
        access.wasAdmin(person, wiki) ||
        (hosts.of(wiki) === entry && entry.settings.serverAdmins.has(person.login.toLowerCase())),
      ...(deps.agentMode === undefined
        ? {}
        : {
            defaultEdits: (person: { id: number }) =>
              deps.agentMode?.(personIdOn(entry.names, person.id)) ?? 'live',
          }),
      ...(tickets === undefined
        ? {}
        : {
            ticketFor: (wiki: WikiRecord, person: { id: number; login: string }) =>
              tickets.issue(wiki.key, personIdOn(entry.names, person.id), person.login),
          }),
      log,
      now: deps.now,
    });

    return { entry, paths, store, sweep, verdict, pages, oauth, mcp };
  }

  const parts = hosts.list().map(partFor);
  const primaryPart = parts.find((part) => part.entry === primary) as HostAgents;
  const partOf = (hostKey: string) => parts.find((part) => part.entry.key === hostKey);

  function serveMcp(part: HostAgents, req: IncomingMessage, res: ServerResponse): void {
    const token = bearerToken(req);
    const record = token === undefined ? undefined : part.store.verify(token);
    if (record === undefined) {
      sendJson(
        res,
        401,
        { error: 'mcp-token-required', tokens: part.paths.agents },
        { 'WWW-Authenticate': part.oauth?.wwwAuthenticate() ?? 'Bearer' },
      );
      return;
    }
    part.mcp.handle(req, res, record.owner).catch((err: unknown) => {
      log.error({ err }, '[gitquire-door] agent request failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'mcp-failed' });
      else if (!res.writableEnded) res.end();
    });
  }

  function handlePart(
    part: HostAgents,
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    search: string,
  ): boolean {
    if (part.oauth?.handle(req, res, path, search) === true) return true;
    const mcpPath = part.paths.mcp;
    if (path === mcpPath || path.startsWith(`${mcpPath}/`)) {
      serveMcp(part, req, res);
      return true;
    }
    return part.pages.handle(req, res, path);
  }

  const combinedSweep: AccessSweep = {
    async runOnce() {
      let revoked = 0;
      for (const part of parts) revoked += await part.sweep.runOnce();
      return revoked;
    },
    stop() {
      for (const part of parts) part.sweep.stop();
    },
  };

  return {
    handle(req, res, path, search) {
      for (const part of parts) {
        if (handlePart(part, req, res, path, search)) return true;
      }
      if (path === '/mcp' || path.startsWith('/mcp/') || path === AGENTS_PAGE_PATH) {
        sendJson(res, 404, {
          error: 'host-key-required',
          message: 'Each Git host has its own address for AI agents; it ends with the host key.',
          mcp: parts.map((part) => new URL(part.paths.mcp, settings.externalUrl).toString()),
          agents: parts.map((part) => part.paths.agents),
        });
        return true;
      }
      return false;
    },
    features(hostKey, person) {
      const part = partOf(hostKey);
      if (part === undefined) return '';
      const records = part.store.list(person.id);
      return encodeAgentFeatures({
        agentToken: records.some((record) => record.kind === 'personal'),
        connector: records.some((record) => record.kind === 'connector'),
        canUseTokens: true,
        canConnect: part.oauth !== undefined,
      });
    },
    pathsFor: (hostKey) => partOf(hostKey)?.paths,
    verdict: (person, hostKey) => (partOf(hostKey ?? primary.key) ?? primaryPart).verdict(person),
    store: primaryPart.store,
    storeOf: (hostKey) => partOf(hostKey)?.store,
    sweep: combinedSweep,
    async close() {
      for (const part of parts) {
        part.sweep.stop();
        part.store.flush();
        await part.mcp.close();
      }
    },
  };
}
