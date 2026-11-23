import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import { type AccessSweep, type AccessVerdict, startAccessSweep } from '../agent-access.ts';
import { AGENTS_PAGE_PATH, createAgentPages } from '../agent-pages.ts';
import { type AgentTokenStore, createAgentTokenStore } from '../agent-tokens.ts';
import { bearerToken, sendJson } from '../http-util.ts';
import { createOAuthServer, type OAuthServer } from '../oauth-server.ts';
import { encodeAgentFeatures } from '../request-person.ts';
import type { DoorPerson, WikiAccess } from './access.ts';
import { createDoorMcp, type DoorMcp } from './mcp.ts';
import type { FrontDoorSettings } from './settings.ts';
import type { WikiProcesses } from './wiki-processes.ts';
import type { WikiTable } from './wiki-table.ts';

export interface DoorAgentsDeps {
  settings: Pick<
    FrontDoorSettings,
    | 'dataDir'
    | 'externalUrl'
    | 'sessionSecret'
    | 'serverAdmins'
    | 'agentTokenDays'
    | 'mcpConnectors'
  >;
  table: Pick<WikiTable, 'list' | 'byAddress'>;
  access: Pick<WikiAccess, 'decide' | 'wasAdmin'>;
  processes: Pick<WikiProcesses, 'ensure' | 'touch' | 'secretOf'>;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  log: GateLogger;
  store?: AgentTokenStore;
  sweepMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface DoorAgents {
  handle: (req: IncomingMessage, res: ServerResponse, path: string, search: string) => boolean;
  features: (person: DoorPerson) => string;
  verdict: (person: DoorPerson) => Promise<AccessVerdict>;
  store: AgentTokenStore;
  sweep: AccessSweep;
  close: () => Promise<void>;
}

function agentTokensFile(dataDir: string): string {
  return join(dataDir, 'server', 'agent-tokens.json');
}

export function createDoorAgents(deps: DoorAgentsDeps): DoorAgents {
  const { settings, table, access, log } = deps;
  const store =
    deps.store ?? createAgentTokenStore({ file: agentTokensFile(settings.dataDir), log });

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
    reason: '[gitquire-agents] revoked agent access: the person has no wiki left on this server',
  });

  const pages = createAgentPages({
    config: {
      externalUrl: settings.externalUrl,
      agentTokenDays: settings.agentTokenDays,
      admins: settings.serverAdmins,
    },
    store,
    log,
    sessionUser: deps.sessionUser,
    connectorsEnabled: settings.mcpConnectors,
    severalWikis: true,
    now: deps.now,
  });

  const oauth: OAuthServer | undefined = settings.mcpConnectors
    ? createOAuthServer({
        externalUrl: settings.externalUrl,
        secret: settings.sessionSecret,
        store,
        log,
        sessionUser: deps.sessionUser,
        checkAccess: (login, id) => verdict({ id, login }),
        severalWikis: true,
        refuseUnknownAtSignIn: true,
        fetch: deps.fetch,
        now: deps.now,
      })
    : undefined;

  const mcp: DoorMcp = createDoorMcp({
    externalUrl: settings.externalUrl,
    table,
    access,
    processes: deps.processes,
    seesWhy: (person, wiki) =>
      access.wasAdmin(person, wiki) || settings.serverAdmins.has(person.login.toLowerCase()),
    log,
    now: deps.now,
  });

  function serveMcp(req: IncomingMessage, res: ServerResponse): void {
    const token = bearerToken(req);
    const record = token === undefined ? undefined : store.verify(token);
    if (record === undefined) {
      sendJson(
        res,
        401,
        { error: 'mcp-token-required', tokens: AGENTS_PAGE_PATH },
        { 'WWW-Authenticate': oauth?.wwwAuthenticate() ?? 'Bearer' },
      );
      return;
    }
    mcp.handle(req, res, record.owner).catch((err: unknown) => {
      log.error({ err }, '[gitquire-door] agent request failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'mcp-failed' });
      else if (!res.writableEnded) res.end();
    });
  }

  return {
    handle(req, res, path, search) {
      if (oauth?.handle(req, res, path, search) === true) return true;
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        serveMcp(req, res);
        return true;
      }
      return pages.handle(req, res, path);
    },
    features(person) {
      const records = store.list(person.id);
      return encodeAgentFeatures({
        agentToken: records.some((record) => record.kind === 'personal'),
        connector: records.some((record) => record.kind === 'connector'),
        canUseTokens: true,
        canConnect: oauth !== undefined,
      });
    },
    verdict,
    store,
    sweep,
    async close() {
      sweep.stop();
      store.flush();
      await mcp.close();
    },
  };
}
