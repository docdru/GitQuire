import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentTokenStore } from '../agent-tokens.ts';
import type { BotAccess, DoorHost, RepoAccess } from '../host/types.ts';
import { ACCESS_TTL_MS, createWikiAccess } from './access.ts';
import { createDoorAgents, type DoorAgents } from './agents.ts';
import type { AllowedOwners } from './allowed-owners.ts';
import { wikiNameOf, withWikiArgument } from './mcp.ts';
import { createFrontDoor } from './server.ts';
import type { FrontDoorSettings } from './settings.ts';
import { createWikiProcesses } from './wiki-processes.ts';
import { openWikiTable, type WikiTable } from './wiki-table.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const CHILD = `
const http = require('node:http');
const sessions = new Set();
let count = 0;
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const server = http.createServer((req, res) => {
  if (req.url === '/readyz') { res.writeHead(200); res.end('ok'); return; }
  if (req.headers['x-gitquire-internal'] !== process.env.GITQUIRE_INTERNAL_SECRET) {
    send(res, 403, { error: 'front-door-only' });
    return;
  }
  if (req.url === '/api/gitquire/stop-state') { send(res, 200, { pushedAndClean: true }); return; }
  if (req.url !== '/mcp') {
    send(res, 200, { repo: process.env.GITQUIRE_REPO, url: req.url, headers: req.headers });
    return;
  }
  const session = req.headers['mcp-session-id'];
  if (req.method === 'DELETE') { sessions.delete(session); send(res, 200, {}); return; }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (msg.method === 'initialize') {
      if (req.headers['x-gitquire-edits-draft'] === 'gone') { send(res, 409, { error: 'draft-not-open' }); return; }
      count += 1;
      const id = process.env.GITQUIRE_REPO.replace('/', '-') + '-' + count;
      sessions.add(id);
      send(res, 200, { jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'stand-in', version: '1' },
      } }, { 'mcp-session-id': id });
      return;
    }
    if (!sessions.has(session)) { send(res, 404, { error: 'MCP session not found' }); return; }
    if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
    if (msg.method === 'tools/list') {
      send(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'read', description: 'Read a page.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
        { name: 'forget', description: 'Forget the sessions.', inputSchema: { type: 'object', properties: {} } },
      ] } });
      return;
    }
    if (msg.method === 'tools/call') {
      if (msg.params.name === 'forget') sessions.clear();
      const person = JSON.parse(Buffer.from(req.headers['x-gitquire-principal'], 'base64url').toString('utf8'));
      const text = JSON.stringify({
        repo: process.env.GITQUIRE_REPO,
        tool: msg.params.name,
        args: msg.params.arguments,
        person,
        prefix: req.headers['x-gitquire-prefix'],
        edits: req.headers['x-gitquire-edits'],
        draft: req.headers['x-gitquire-edits-draft'],
        session,
      });
      send(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
      return;
    }
    send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  });
});
const socket = process.env.GITQUIRE_SOCKET;
server.listen(socket);
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
`;

const repoA = { host: 'github' as const, id: 1, owner: 'team', ownerId: 7, name: 'a' };
const repoB = { host: 'github' as const, id: 2, owner: 'team', ownerId: 7, name: 'b' };

const people = {
  alice: { id: 11, login: 'alice', name: 'Alice', avatarUrl: '' },
  bob: { id: 12, login: 'bob', name: 'Bob', avatarUrl: '' },
  carol: { id: 13, login: 'carol', name: 'Carol', avatarUrl: '' },
};

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-door-mcp-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Rig {
  base: string;
  agents: DoorAgents;
  table: WikiTable;
  levels: Record<string, Record<string, RepoAccess>>;
  bot: { answer: BotAccess | undefined };
  advance: (ms: number) => void;
  token: (who: keyof typeof people) => string;
}

async function rig(): Promise<Rig> {
  let handler: Parameters<typeof createServer>[1] = () => {};
  const server: Server = createServer((req, res) => handler?.(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const data = tempDir();
  const script = join(tempDir(), 'child.cjs');
  writeFileSync(script, CHILD);
  let time = Date.now();
  const levels: Rig['levels'] = {
    alice: { a: 'admin', b: 'write' },
    bob: { a: 'write', b: 'none' },
    carol: { a: 'none', b: 'none' },
  };
  const bot: Rig['bot'] = { answer: undefined };
  const host: DoorHost = {
    authorizeUrl: ({ state }) => `https://host.example/authorize?state=${state}`,
    exchangeCode: async ({ code }) => `token-${code}`,
    person: async (token) => people[token.slice(6) as keyof typeof people],
    access: async (token, repo) => levels[token.slice(6)]?.[repo.name] ?? 'none',
    accessByBot: async (login, repo) => bot.answer ?? levels[login]?.[repo.name] ?? 'none',
    addableRepos: async () => ({ state: 'listed', repos: [] }),
    repoById: async (id) => {
      const found = [repoA, repoB].find((r) => r.id === id);
      return found === undefined ? { state: 'gone' } : { state: 'found', repo: found };
    },
    health: async () => 'ok',
    tokenFor: async () => 'tok',
    selfCheck: async () => ({ ok: true }),
  };
  const table = openWikiTable(join(data, 'server', 'wikis.json'));
  table.add(repoA, 'alice', time);
  table.add(repoB, 'alice', time);
  const owners: AllowedOwners = {
    names: new Set(['team']),
    pinned: table.ownerIds,
    pin: table.pinOwner,
  };
  const settings: FrontDoorSettings = {
    host: 'github',
    dataDir: data,
    externalUrl: new URL(`http://127.0.0.1:${port}`),
    clientId: 'id',
    clientSecret: 'secret',
    sessionSecret: '0123456789abcdef0123456789abcdef',
    sessionMaxAgeSeconds: 3600,
    webUrl: 'https://host.example',
    apiUrl: 'https://host.example/api',
    defaultWiki: undefined,
    allowedOwners: owners.names,
    serverAdmins: new Set(['alice']),
    githubApp: undefined,
    forgejoBotToken: undefined,
    agentTokenDays: 30,
    mcpConnectors: true,
  };
  const now = () => time;
  const access = createWikiAccess({
    host,
    runnable: () => true,
    refused: (wiki, refusal) => table.disconnect(wiki.key, refusal),
    now,
  });
  const processes = createWikiProcesses({
    dataDir: data,
    externalUrl: settings.externalUrl,
    env: { PATH: process.env.PATH },
    cli: [process.execPath, script],
    host,
    table,
    owners,
    tokenSocket: () => '/tmp/none.sock',
    log: silentLog,
    bootstrap: async () => {},
    now,
  });
  cleanup.push(() => processes.stopAll());
  let sessionUser: Parameters<typeof createDoorAgents>[0]['sessionUser'] = () => undefined;
  const store = createAgentTokenStore({
    file: join(data, 'server', 'agent-tokens.json'),
    log: silentLog,
    now,
  });
  const agents = createDoorAgents({
    settings,
    table,
    access,
    processes,
    sessionUser: (req) => sessionUser(req),
    log: silentLog,
    store,
    now,
  });
  cleanup.push(() => agents.close());
  const door = createFrontDoor({
    settings,
    host,
    table,
    owners,
    access,
    processes,
    agents,
    log: silentLog,
    now,
    randomState: () => 'state-1',
  });
  sessionUser = door.sessionUser;
  door.setReady(true);
  handler = door.handleRequest;
  return {
    base: `http://127.0.0.1:${port}`,
    agents,
    table,
    levels,
    bot,
    advance: (ms) => {
      time += ms;
    },
    token: (who) => store.createPersonal(people[who], 'test', 30).token,
  };
}

async function connect(r: Rig, token: string, name = 'test-agent'): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${r.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: '1' });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((part) => part.text).join('\n');
}

function echoOf(result: unknown): {
  repo: string;
  tool: string;
  args: Record<string, unknown>;
  person: Record<string, unknown>;
  prefix: string;
  edits?: string;
  draft?: string;
  session: string;
} {
  return JSON.parse(textOf(result));
}

function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          cookies: (res.headers['set-cookie'] ?? []).map((line) => line.split(';')[0] ?? ''),
        }),
      );
    });
    sent.on('error', reject);
    sent.end();
  });
}

describe('wiki argument helpers', () => {
  const origin = new URL('https://wiki.example');

  it('reads the wiki from owner/name, its address or its full URL', () => {
    expect(wikiNameOf('team/a', origin)).toEqual({ owner: 'team', name: 'a' });
    expect(wikiNameOf('/w/team/a/', origin)).toEqual({ owner: 'team', name: 'a' });
    expect(wikiNameOf('https://wiki.example/w/team/a/', origin)).toEqual({
      owner: 'team',
      name: 'a',
    });
    expect(wikiNameOf('team', origin)).toBeNull();
    expect(wikiNameOf('team/a/b', origin)).toBeNull();
    expect(wikiNameOf('../a', origin)).toBeNull();
    expect(wikiNameOf('team/a b', origin)).toBeNull();
  });

  it('adds the wiki argument, required only when asked, and the optional workspace', () => {
    const tool = {
      name: 'read',
      inputSchema: {
        type: 'object' as const,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    };
    expect(withWikiArgument(tool, true).inputSchema.required).toEqual(['path', 'wiki']);
    expect(withWikiArgument(tool, false).inputSchema.required).toEqual(['path']);
    expect(Object.keys(withWikiArgument(tool, false).inputSchema.properties ?? {})).toEqual([
      'path',
      'wiki',
      'workspace',
    ]);
    expect(tool.inputSchema.required).toEqual(['path']);
  });
});

describe('/mcp at the front door', () => {
  it('refuses /mcp without an agent token, with the sign-in hint', async () => {
    const r = await rig();
    const answer = await httpGet(`${r.base}/mcp`);
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.body)).toMatchObject({ error: 'mcp-token-required' });
  });

  it('serves the connector discovery at the root', async () => {
    const r = await rig();
    const answer = await httpGet(`${r.base}/.well-known/oauth-protected-resource/mcp`);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ resource: `${r.base}/mcp` });
  });

  it('lists the wikis and forwards each call to the named wiki with the person', async () => {
    const r = await rig();
    const client = await connect(r, r.token('alice'), 'Claude');
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['list_wikis', 'read', 'forget']);
    const read = tools.tools.find((tool) => tool.name === 'read');
    expect(read?.inputSchema.required).toEqual(['path', 'wiki']);

    const listed = await client.callTool({ name: 'list_wikis', arguments: {} });
    expect(listed.structuredContent).toEqual({
      wikis: [
        { wiki: 'team/a', address: `${r.base}/w/team/a/`, admin: true },
        { wiki: 'team/b', address: `${r.base}/w/team/b/`, admin: false },
      ],
    });

    const inA = echoOf(
      await client.callTool({ name: 'read', arguments: { wiki: 'team/a', path: 'x' } }),
    );
    expect(inA).toMatchObject({
      repo: 'team/a',
      tool: 'read',
      args: { path: 'x' },
      prefix: '/w/team/a',
    });
    expect(inA.person).toMatchObject({ id: 11, login: 'alice', repoAdmin: true });

    const inB = echoOf(
      await client.callTool({ name: 'read', arguments: { wiki: '/w/team/b/', path: 'y' } }),
    );
    expect(inB).toMatchObject({ repo: 'team/b', args: { path: 'y' }, prefix: '/w/team/b' });
    expect(inB.person.repoAdmin).toBeUndefined();

    const again = echoOf(
      await client.callTool({ name: 'read', arguments: { wiki: 'team/a', path: 'z' } }),
    );
    expect(again.session).toBe(inA.session);
  });

  it('routes each call to the workspace it names, on its own connection', async () => {
    const r = await rig();
    const client = await connect(r, r.token('alice'));
    const read = (await client.listTools()).tools.find((tool) => tool.name === 'read');
    expect(Object.keys(read?.inputSchema.properties ?? {})).toContain('workspace');
    expect(read?.inputSchema.required).not.toContain('workspace');

    const plain = echoOf(
      await client.callTool({ name: 'read', arguments: { wiki: 'team/a', path: 'x' } }),
    );
    expect(plain).toMatchObject({ args: { path: 'x' } });
    expect(plain.edits).toBeUndefined();
    expect(plain.draft).toBeUndefined();

    const live = echoOf(
      await client.callTool({
        name: 'read',
        arguments: { wiki: 'team/a', workspace: 'live', path: 'x' },
      }),
    );
    expect(live).toMatchObject({ edits: 'live', args: { path: 'x' } });
    expect(live.session).not.toBe(plain.session);

    const named = echoOf(
      await client.callTool({
        name: 'read',
        arguments: { wiki: 'team/a', workspace: 'draft:pricing-page', path: 'x' },
      }),
    );
    expect(named).toMatchObject({ edits: 'draft', draft: 'pricing-page' });
    const again = echoOf(
      await client.callTool({
        name: 'read',
        arguments: { wiki: 'team/a', workspace: 'draft:pricing-page', path: 'y' },
      }),
    );
    expect(again.session).toBe(named.session);

    const own = echoOf(
      await client.callTool({ name: 'read', arguments: { wiki: 'team/a', workspace: 'draft' } }),
    );
    expect(own.edits).toBe('draft');
    expect(own.draft).toBeUndefined();
  });

  it('refuses a workspace it cannot read and a draft that is not open', async () => {
    const r = await rig();
    const client = await connect(r, r.token('alice'));
    const odd = await client.callTool({
      name: 'read',
      arguments: { wiki: 'team/a', workspace: 'main' },
    });
    expect(odd.isError).toBe(true);
    expect(textOf(odd)).toContain('"live", "draft" or "draft:<name>"');

    const gone = await client.callTool({
      name: 'read',
      arguments: { wiki: 'team/a', workspace: 'draft:gone' },
    });
    expect(gone.isError).toBe(true);
    expect(textOf(gone)).toContain('The draft "gone" is not open in team/a');
  });

  it('asks for the wiki when the person has several and none is named', async () => {
    const r = await rig();
    const client = await connect(r, r.token('alice'));
    const result = await client.callTool({ name: 'read', arguments: { path: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('team/a, team/b');
    const unknown = await client.callTool({ name: 'read', arguments: { wiki: 'team/zz' } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('list_wikis');
  });

  it('lets a person with exactly one wiki leave it out', async () => {
    const r = await rig();
    const client = await connect(r, r.token('bob'));
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === 'read')?.inputSchema.required).toEqual([
      'path',
    ]);
    const result = echoOf(await client.callTool({ name: 'read', arguments: { path: 'x' } }));
    expect(result.repo).toBe('team/a');
    expect(result.person).toMatchObject({ login: 'bob' });
  });

  it('checks access for the named wiki on every call, answering like an unknown name', async () => {
    const r = await rig();
    const client = await connect(r, r.token('bob'));
    const refused = await client.callTool({ name: 'read', arguments: { wiki: 'team/b' } });
    expect(refused.isError).toBe(true);
    const unknown = await client.callTool({ name: 'read', arguments: { wiki: 'team/zz' } });
    expect(textOf(refused)).toBe(textOf(unknown).replace('team/zz', 'team/b'));

    expect(
      echoOf(await client.callTool({ name: 'read', arguments: { wiki: 'team/a' } })).repo,
    ).toBe('team/a');
    r.levels.bob.a = 'none';
    r.advance(ACCESS_TTL_MS + 1);
    const lost = await client.callTool({ name: 'read', arguments: { wiki: 'team/a' } });
    expect(lost.isError).toBe(true);
    expect(textOf(lost)).toContain('There is no wiki called "team/a"');
  });

  it('keeps a person inside while the host is unreachable, and closes a refused wiki, saying so only to admins', async () => {
    const r = await rig();
    const client = await connect(r, r.token('bob'));
    const admin = await connect(r, r.token('alice'));
    await client.callTool({ name: 'read', arguments: { wiki: 'team/a' } });
    r.bot.answer = 'unreachable';
    r.advance(ACCESS_TTL_MS + 1);
    expect(
      echoOf(await client.callTool({ name: 'read', arguments: { wiki: 'team/a' } })).repo,
    ).toBe('team/a');
    r.bot.answer = 'refused:removed';
    r.advance(ACCESS_TTL_MS + 1);
    const closed = await client.callTool({ name: 'read', arguments: { wiki: 'team/a' } });
    expect(closed.isError).toBe(true);
    expect(textOf(closed)).toContain('There is no wiki called "team/a"');
    expect(r.table.byKey('github-1')?.state).toBe('disconnected');
    const told = await admin.callTool({ name: 'read', arguments: { wiki: 'team/a' } });
    expect(told.isError).toBe(true);
    expect(textOf(told)).toBe('The wiki team/a is disconnected.');
  });

  it('opens a new session with the wiki when the wiki forgot the old one', async () => {
    const r = await rig();
    const client = await connect(r, r.token('alice'));
    const first = echoOf(await client.callTool({ name: 'forget', arguments: { wiki: 'team/a' } }));
    const second = echoOf(await client.callTool({ name: 'read', arguments: { wiki: 'team/a' } }));
    expect(second.session).not.toBe(first.session);
    expect(second.repo).toBe('team/a');
  });

  it('keeps one person’s session away from another person', async () => {
    const r = await rig();
    const alice = await connect(r, r.token('alice'));
    await alice.listTools();
    const sessionId = (alice.transport as StreamableHTTPClientTransport).sessionId ?? '';
    const answer = await new Promise<number>((resolve, reject) => {
      const sent = request(
        `${r.base}/mcp`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${r.token('bob')}`,
            'mcp-session-id': sessionId,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      sent.on('error', reject);
      sent.end(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
    });
    expect(answer).toBe(403);
  });

  it('answers GET with 405, also on an open session, and opens no stream', async () => {
    const r = await rig();
    const client = await connect(r, r.token('alice'));
    await client.listTools();
    const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId ?? '';
    const answer = await httpGet(`${r.base}/mcp`, {
      authorization: `Bearer ${r.token('alice')}`,
      'mcp-session-id': sessionId,
      accept: 'text/event-stream',
    });
    expect(answer.status).toBe(405);
  });

  it('opens no session for a person who can open no wiki', async () => {
    const r = await rig();
    await expect(connect(r, r.token('carol'))).rejects.toThrow();
  });

  it('caps the sessions of one person', async () => {
    const r = await rig();
    const token = r.token('alice');
    for (let i = 0; i < 10; i += 1) await connect(r, token);
    await expect(connect(r, token)).rejects.toThrow();
    expect((await connect(r, r.token('bob'))).getServerVersion()).toBeDefined();
  });

  it('lists only list_wikis once the person can open no wiki', async () => {
    const r = await rig();
    const client = await connect(r, r.token('bob'));
    expect((await client.listTools()).tools.length).toBeGreaterThan(1);
    r.levels.bob.a = 'none';
    r.advance(ACCESS_TTL_MS + 1);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['list_wikis']);
  });

  it('refuses /mcp under a wiki address and names the one address', async () => {
    const r = await rig();
    const answer = await httpGet(`${r.base}/w/team/a/mcp`);
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toEqual(
      expect.objectContaining({ error: 'mcp-at-root', mcp: `${r.base}/mcp` }),
    );
  });

  it('tells the wiki the person’s agent access when it answers /auth/me', async () => {
    const r = await rig();
    r.token('alice');
    const start = await httpGet(`${r.base}/auth/github/login?next=%2F`);
    const state = start.cookies.find((c) => c.startsWith('gq_oauth_state=')) ?? '';
    const back = await httpGet(`${r.base}/auth/github/callback?code=alice&state=state-1`, {
      cookie: state,
    });
    const session = back.cookies.find((c) => c.startsWith('gq_session=')) ?? '';
    const me = await httpGet(`${r.base}/w/team/a/auth/me`, { cookie: session });
    const echoed = JSON.parse(me.body) as { headers: Record<string, string> };
    expect(echoed.headers['x-gitquire-agents']).toBe('token,tokens,connect');
    const page = await httpGet(`${r.base}/w/team/a/page`, { cookie: session });
    expect(
      (JSON.parse(page.body) as { headers: Record<string, string> }).headers['x-gitquire-agents'],
    ).toBeUndefined();
  });
});

describe('agent tokens at the front door (R9)', () => {
  it('revokes a person’s tokens only when no wiki is left', async () => {
    const r = await rig();
    r.token('bob');
    r.token('carol');
    expect(await r.agents.sweep.runOnce()).toBe(1);
    expect(r.agents.store.owners().map((owner) => owner.login)).toEqual(['bob']);

    r.levels.bob.a = 'none';
    r.bot.answer = 'unreachable';
    r.advance(ACCESS_TTL_MS + 1);
    expect(await r.agents.sweep.runOnce()).toBe(0);

    r.bot.answer = undefined;
    r.levels.bob.b = 'write';
    r.advance(ACCESS_TTL_MS + 1);
    expect(await r.agents.sweep.runOnce()).toBe(0);
    expect(r.agents.store.owners().map((owner) => owner.login)).toEqual(['bob']);

    r.levels.bob.b = 'none';
    r.advance(ACCESS_TTL_MS + 1);
    expect(await r.agents.sweep.runOnce()).toBe(1);
    expect(r.agents.store.owners()).toEqual([]);
  });

  it('answers allowed, unknown or denied for a person across all wikis', async () => {
    const r = await rig();
    expect(await r.agents.verdict(people.bob)).toBe('allowed');
    expect(await r.agents.verdict(people.carol)).toBe('denied');
    r.bot.answer = 'unreachable';
    expect(await r.agents.verdict({ id: 99, login: 'nobody' })).toBe('unknown');
  });
});
