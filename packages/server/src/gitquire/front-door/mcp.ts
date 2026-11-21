import { randomUUID } from 'node:crypto';
import { type IncomingMessage, request, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { MCP_SERVER_NAME } from '@gitquire/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { RUNTIME_VERSION } from '../../version-constants.ts';
import type { GateLogger } from '../access-gate.ts';
import type { AgentTokenRecord } from '../agent-tokens.ts';
import { INTERNAL_REQUEST_HEADER } from '../internal-request.ts';
import {
  encodeProxiedUser,
  FORWARDED_PREFIX_HEADER,
  PROXIED_PRINCIPAL_HEADER,
} from '../request-person.ts';
import type { OpenDecision, WikiAccess } from './access.ts';
import { WikiClosedError, type WikiProcesses } from './wiki-processes.ts';
import { type WikiRecord, type WikiTable, wikiPrefix } from './wiki-table.ts';

const LIST_WIKIS_TOOL = 'list_wikis';
const WIKI_ARGUMENT = 'wiki';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const TOOL_LIST_MAX_AGE_MS = 10 * 60 * 1000;
const WIKI_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 80;
const MAX_SESSIONS_PER_PERSON = 10;

type AgentPerson = AgentTokenRecord['owner'];

interface DoorMcpDeps {
  externalUrl: URL;
  table: Pick<WikiTable, 'list' | 'byAddress'>;
  access: Pick<WikiAccess, 'decide'>;
  processes: Pick<WikiProcesses, 'ensure' | 'touch' | 'secretOf'>;
  log: GateLogger;
  now?: () => number;
  sessionTtlMs?: number;
  maxSessions?: number;
  maxSessionsPerPerson?: number;
}

export interface DoorMcp {
  handle: (req: IncomingMessage, res: ServerResponse, person: AgentPerson) => Promise<void>;
  close: () => Promise<void>;
}

interface WikiTarget {
  socket: string;
  admin: boolean;
}

interface WikiConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  target: WikiTarget;
}

interface DoorSession {
  id?: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  person: AgentPerson;
  wikis: Map<string, Promise<WikiConnection>>;
  ttlTimer?: ReturnType<typeof setTimeout>;
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const WIKI_ARGUMENT_SCHEMA = {
  type: 'string',
  description: `The wiki, as ${LIST_WIKIS_TOOL} names it (owner/repository, for example team/handbook). May be left out when you can open exactly one wiki.`,
};

const LIST_WIKIS: Tool = {
  name: LIST_WIKIS_TOOL,
  title: 'List wikis',
  description: `List the wikis you can open on this GitQuire server. Every other tool takes one of these names as its "${WIKI_ARGUMENT}" argument; with exactly one wiki it may be left out.`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

const INSTRUCTIONS = `One connection reaches every wiki you can open on this server. Call ${LIST_WIKIS_TOOL} first, then name the wiki in the "${WIKI_ARGUMENT}" argument of every other tool.`;

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

function webHeaders(raw: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

function socketFetch(target: () => { socket: string; headers: Record<string, string> }) {
  const fetchLike: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') return new Response(null, { status: 405 });
    const { socket, headers: extra } = target();
    const address = new URL(url);
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
    const headers: Record<string, string> = {
      ...headerRecord(init),
      ...extra,
      host: '127.0.0.1',
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    };
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        {
          socketPath: socket,
          path: `${address.pathname}${address.search}`,
          method,
          headers,
          signal: init?.signal ?? undefined,
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          if (NULL_BODY_STATUSES.has(status)) {
            incoming.resume();
            resolve(new Response(null, { status, headers: webHeaders(incoming.headers) }));
            return;
          }
          const stream = Readable.toWeb(incoming) as WebReadableStream<Uint8Array>;
          resolve(
            new Response(stream as unknown as BodyInit, {
              status,
              headers: webHeaders(incoming.headers),
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
  return fetchLike;
}

export function wikiNameOf(raw: string, externalUrl: URL): { owner: string; name: string } | null {
  let text = raw.trim();
  if (text.startsWith(externalUrl.origin)) text = text.slice(externalUrl.origin.length);
  text = text.replace(/^\/+/, '');
  if (text.startsWith('w/')) text = text.slice(2);
  const parts = text.replace(/\/+$/, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!/^[A-Za-z0-9._~-]+$/.test(owner) || !/^[A-Za-z0-9._~-]+$/.test(name)) return null;
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return null;
  return { owner, name };
}

export function withWikiArgument(tool: Tool, required: boolean): Tool {
  const schema = tool.inputSchema;
  const properties = { ...schema.properties, [WIKI_ARGUMENT]: WIKI_ARGUMENT_SCHEMA };
  const listed = Array.isArray(schema.required)
    ? schema.required.filter((name) => name !== WIKI_ARGUMENT)
    : undefined;
  const requiredNames = required ? [...(listed ?? []), WIKI_ARGUMENT] : listed;
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties,
      ...(requiredNames && { required: requiredNames }),
    },
  };
}

function refusal(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function closedText(wiki: WikiRecord, decision: Exclude<OpenDecision, { open: true }>): string {
  const name = `${wiki.owner}/${wiki.name}`;
  if (decision.why === 'no-access') return `You do not have write access to ${name}.`;
  if (decision.why === 'unreachable') {
    return `The Git host cannot be reached right now, so GitQuire cannot check your access to ${name}. Try again in a moment.`;
  }
  return `The wiki ${name} is disconnected.`;
}

export function createDoorMcp(deps: DoorMcpDeps): DoorMcp {
  const now = deps.now ?? Date.now;
  const sessionTtlMs = deps.sessionTtlMs ?? 30 * 60 * 1000;
  const maxSessions = deps.maxSessions ?? MAX_SESSIONS;
  const maxPerPerson = deps.maxSessionsPerPerson ?? MAX_SESSIONS_PER_PERSON;
  const sessions = new Map<string, DoorSession>();
  let toolList: { at: number; tools: Tool[] } | undefined;

  async function openWikis(person: AgentPerson): Promise<WikiRecord[]> {
    const wikis = deps.table.list().filter((wiki) => wiki.state === 'on');
    const decisions = await Promise.all(
      wikis.map(async (wiki) => ({ wiki, decision: await deps.access.decide(person, wiki) })),
    );
    return decisions.filter(({ decision }) => decision.open).map(({ wiki }) => wiki);
  }

  function headersFor(session: DoorSession, wiki: WikiRecord, target: WikiTarget) {
    return {
      [INTERNAL_REQUEST_HEADER]: deps.processes.secretOf(wiki.key) ?? '',
      [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser({
        ...session.person,
        ...(target.admin ? { repoAdmin: true } : {}),
      }),
      [FORWARDED_PREFIX_HEADER]: wikiPrefix(wiki),
    };
  }

  async function connectWiki(
    session: DoorSession,
    wiki: WikiRecord,
    target: WikiTarget,
  ): Promise<WikiConnection> {
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
      fetch: socketFetch(() => ({
        socket: target.socket,
        headers: headersFor(session, wiki, target),
      })),
      reconnectionOptions: {
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
    const agent = session.server.server.getClientVersion();
    const client = new Client({
      name: agent?.name ?? 'GitQuire front door',
      version: agent?.version ?? RUNTIME_VERSION,
    });
    await client.connect(transport);
    return { client, transport, target };
  }

  async function dropWiki(session: DoorSession, key: string): Promise<void> {
    const pending = session.wikis.get(key);
    session.wikis.delete(key);
    if (pending === undefined) return;
    const connection = await pending.catch(() => undefined);
    if (connection === undefined) return;
    await connection.transport.terminateSession().catch(() => undefined);
    await connection.client.close().catch(() => undefined);
  }

  async function wikiConnection(
    session: DoorSession,
    wiki: WikiRecord,
    target: WikiTarget,
  ): Promise<WikiConnection> {
    let pending = session.wikis.get(wiki.key);
    if (pending === undefined) {
      pending = connectWiki(session, wiki, target);
      session.wikis.set(wiki.key, pending);
      pending.catch(() => {
        if (session.wikis.get(wiki.key) === pending) session.wikis.delete(wiki.key);
      });
    }
    const connection = await pending;
    connection.target.socket = target.socket;
    connection.target.admin = target.admin;
    return connection;
  }

  function sessionGone(err: unknown): boolean {
    return err instanceof StreamableHTTPError && (err.code === 404 || err.code === 403);
  }

  async function withWiki<T>(
    session: DoorSession,
    wiki: WikiRecord,
    target: WikiTarget,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    try {
      return await work((await wikiConnection(session, wiki, target)).client);
    } catch (err) {
      if (!sessionGone(err)) throw err;
      await dropWiki(session, wiki.key);
      return work((await wikiConnection(session, wiki, target)).client);
    }
  }

  async function opened(
    session: DoorSession,
    wiki: WikiRecord,
  ): Promise<{ target: WikiTarget } | { refused: string }> {
    const decision = await deps.access.decide(session.person, wiki);
    if (!decision.open) return { refused: closedText(wiki, decision) };
    let socket: string;
    try {
      socket = await deps.processes.ensure(wiki);
    } catch (err) {
      deps.log.warn({ err, wiki: wiki.key }, '[gitquire-door] could not start a wiki for an agent');
      return {
        refused:
          err instanceof WikiClosedError
            ? `The wiki ${wiki.owner}/${wiki.name} is disconnected.`
            : `The wiki ${wiki.owner}/${wiki.name} could not be started. Try again in a moment.`,
      };
    }
    deps.processes.touch(wiki.key);
    return { target: { socket, admin: decision.admin } };
  }

  async function wikiTools(session: DoorSession, first: WikiRecord | undefined): Promise<Tool[]> {
    if (first === undefined) return [];
    if (toolList !== undefined && now() - toolList.at < TOOL_LIST_MAX_AGE_MS) return toolList.tools;
    const open = await opened(session, first);
    if ('refused' in open) return toolList?.tools ?? [];
    try {
      const listed = await withWiki(session, first, open.target, (client) => client.listTools());
      const tools = listed.tools.filter((tool) => tool.name !== LIST_WIKIS_TOOL);
      toolList = { at: now(), tools };
      return tools;
    } catch (err) {
      deps.log.warn({ err, wiki: first.key }, '[gitquire-door] could not list a wiki’s tools');
      return toolList?.tools ?? [];
    }
  }

  async function listWikisResult(person: AgentPerson): Promise<CallToolResult> {
    const wikis = await openWikis(person);
    const items = await Promise.all(
      wikis.map(async (wiki) => {
        const decision = await deps.access.decide(person, wiki);
        return {
          wiki: `${wiki.owner}/${wiki.name}`,
          address: `${deps.externalUrl.origin}${wikiPrefix(wiki)}/`,
          admin: decision.open && decision.admin,
        };
      }),
    );
    const text =
      items.length === 0
        ? 'You cannot open any wiki on this server.'
        : items
            .map((item) => `${item.wiki} — ${item.address}${item.admin ? ' (admin)' : ''}`)
            .join('\n');
    return { content: [{ type: 'text', text }], structuredContent: { wikis: items } };
  }

  async function chooseWiki(
    person: AgentPerson,
    named: unknown,
  ): Promise<{ wiki: WikiRecord } | { refused: string }> {
    if (named === undefined || named === null || named === '') {
      const wikis = await openWikis(person);
      if (wikis.length === 1) return { wiki: wikis[0] };
      if (wikis.length === 0) return { refused: 'You cannot open any wiki on this server.' };
      const names = wikis.map((wiki) => `${wiki.owner}/${wiki.name}`).join(', ');
      return {
        refused: `Name the wiki in the "${WIKI_ARGUMENT}" argument. You can open: ${names}.`,
      };
    }
    const parsed = typeof named === 'string' ? wikiNameOf(named, deps.externalUrl) : null;
    const match = parsed === null ? undefined : deps.table.byAddress(parsed.owner, parsed.name);
    if (match === undefined) {
      return {
        refused: `There is no wiki called ${JSON.stringify(named)} on this server. Call ${LIST_WIKIS_TOOL} for the names.`,
      };
    }
    return { wiki: match.wiki };
  }

  function createSessionServer(session: Omit<DoorSession, 'server'>): McpServer {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: RUNTIME_VERSION },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    const full = session as DoorSession;
    server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const wikis = await openWikis(full.person);
      const tools = await wikiTools(full, wikis[0]);
      return {
        tools: [LIST_WIKIS, ...tools.map((tool) => withWikiArgument(tool, wikis.length !== 1))],
      };
    });
    server.server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
      const name = call.params.name;
      if (name === LIST_WIKIS_TOOL) return listWikisResult(full.person);
      const { [WIKI_ARGUMENT]: named, ...rest } = call.params.arguments ?? {};
      const chosen = await chooseWiki(full.person, named);
      if ('refused' in chosen) return refusal(chosen.refused);
      const wiki = chosen.wiki;
      const open = await opened(full, wiki);
      if ('refused' in open) return refusal(open.refused);
      deps.log.info(
        { wiki: wiki.key, login: full.person.login, tool: name },
        '[gitquire-door] agent call',
      );
      const result = await withWiki(full, wiki, open.target, (client) =>
        client.callTool({ name, arguments: rest }, undefined, {
          signal: extra.signal,
          timeout: WIKI_CALL_TIMEOUT_MS,
        }),
      );
      return result as CallToolResult;
    });
    return server;
  }

  async function closeSession(id: string, reason: string): Promise<void> {
    const session = sessions.get(id);
    if (session === undefined) return;
    sessions.delete(id);
    if (session.ttlTimer !== undefined) clearTimeout(session.ttlTimer);
    await Promise.allSettled([...session.wikis.keys()].map((key) => dropWiki(session, key)));
    await Promise.allSettled([session.server.close(), session.transport.close()]);
    deps.log.info({ sessionId: id, reason }, '[gitquire-door] agent session closed');
  }

  function touch(id: string, session: DoorSession): void {
    if (session.ttlTimer !== undefined) clearTimeout(session.ttlTimer);
    session.ttlTimer = setTimeout(() => {
      void closeSession(id, 'ttl-expired');
    }, sessionTtlMs);
    session.ttlTimer.unref?.();
  }

  function writePlain(
    res: ServerResponse,
    status: number,
    message: string,
    headers: Record<string, string> = {},
  ): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(message);
  }

  function sessionsOf(person: AgentPerson): number {
    let count = 0;
    for (const session of sessions.values()) if (session.person.id === person.id) count += 1;
    return count;
  }

  return {
    async handle(req, res, person) {
      if (req.method === 'GET') {
        writePlain(res, 405, 'This server sends no event stream; use POST.', {
          Allow: 'POST, DELETE',
        });
        return;
      }
      const header = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(header) ? header[0] : header;
      if (sessionId !== undefined && sessionId !== '') {
        const session = sessions.get(sessionId);
        if (session === undefined) {
          writePlain(res, 404, 'MCP session not found');
          return;
        }
        if (session.person.id !== person.id) {
          writePlain(res, 403, 'This MCP session belongs to another user');
          return;
        }
        session.person = person;
        touch(sessionId, session);
        await session.transport.handleRequest(req, res);
        return;
      }
      if (req.method !== 'POST') {
        writePlain(res, 400, 'Missing MCP session. Initialize with POST /mcp first.');
        return;
      }
      if (sessions.size >= maxSessions) {
        writePlain(res, 503, 'Too many active MCP sessions');
        return;
      }
      if (sessionsOf(person) >= maxPerPerson) {
        writePlain(
          res,
          429,
          `You already have ${maxPerPerson} open MCP connections. Close one, or wait until one expires.`,
        );
        return;
      }
      if ((await openWikis(person)).length === 0) {
        writePlain(res, 403, 'You cannot open any wiki on this server.');
        return;
      }
      const partial: Omit<DoorSession, 'server' | 'transport'> & {
        transport?: StreamableHTTPServerTransport;
      } = { person, wikis: new Map() };
      const transport = new StreamableHTTPServerTransport({
        maxRequestBodySize: MAX_BODY_BYTES,
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          const session = partial as DoorSession;
          session.id = id;
          sessions.set(id, session);
          touch(id, session);
          deps.log.info(
            { sessionId: id, login: person.login },
            '[gitquire-door] agent session started',
          );
        },
      });
      partial.transport = transport;
      const session = partial as DoorSession;
      session.server = createSessionServer(session);
      transport.onclose = () => {
        if (session.id !== undefined) void closeSession(session.id, 'transport-closed');
      };
      transport.onerror = (err) => {
        deps.log.warn({ err }, '[gitquire-door] agent transport error');
      };
      await session.server.connect(transport);
      await transport.handleRequest(req, res);
    },

    async close() {
      await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id, 'door-close')));
    },
  };
}
