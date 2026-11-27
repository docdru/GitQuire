import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgejoNames, gitHubNames } from '../host/names.ts';
import type { BotAccess, DoorHost, HostPerson, HostRepoRecord, RepoAccess } from '../host/types.ts';
import { createWikiAccess } from './access.ts';
import { createDoorAgents, type DoorAgents } from './agents.ts';
import type { AllowedOwners } from './allowed-owners.ts';
import { type DoorHostEntry, doorHostPaths, doorHosts } from './door-hosts.ts';
import type { HostSettings } from './hosts.ts';
import { createMentionCounts } from './mention-counts.ts';
import { createFrontDoor, type FrontDoor } from './server.ts';
import type { FrontDoorSettings } from './settings.ts';
import { createWikiProcesses, type WikiProcesses } from './wiki-processes.ts';
import { openWikiTable, type WikiTable } from './wiki-table.ts';

export const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

export const CHILD = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.url === '/readyz') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/api/gitquire/stop-state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pushedAndClean: true }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ repo: process.env.GITQUIRE_REPO, host: process.env.GITQUIRE_HOST, key: process.env.GITQUIRE_HOST_KEY ?? null, url: req.url, headers: req.headers }));
});
server.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');
  socket.on('data', (chunk) => socket.write(chunk));
});
server.listen(process.env.GITQUIRE_SOCKET);
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
`;

export interface Answer {
  status: number;
  headers: { get: (name: string) => string | null; getSetCookie: () => string[] };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

export function httpFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (name) => {
              const value = res.headers[name.toLowerCase()];
              return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value;
            },
            getSetCookie: () => res.headers['set-cookie'] ?? [],
          },
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
    sent.on('error', reject);
    sent.end(init.body);
  });
}

export function cookiesOf(response: Answer): string[] {
  return response.headers.getSetCookie().map((line) => line.split(';')[0] ?? '');
}

export type HostKeyName = 'github' | 'forgejo';

export interface FakeHostState {
  people: Record<string, HostPerson>;
  levels: Record<string, Record<string, RepoAccess>>;
  repos: HostRepoRecord[];
  bot: { answer: BotAccess | undefined; down: boolean; hang?: boolean };
  asked: string[];
}

function fakeHost(kind: HostKeyName, state: FakeHostState): DoorHost {
  const name = (repo: { id?: number; name: string }) =>
    state.repos.find((candidate) => candidate.id === repo.id)?.name ?? repo.name;
  const down = () => {
    if (state.bot.down) throw new Error(`${kind} is down`);
  };
  return {
    authorizeUrl: ({ state: s, redirectUri }) =>
      `https://${kind}.example/authorize?state=${s}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async ({ code, clientId, clientSecret }) => {
      down();
      state.asked.push(`exchange:${clientId}:${clientSecret}`);
      return `${kind}-token-${code}`;
    },
    person: async (token) => {
      down();
      return state.people[token.slice(`${kind}-token-`.length)];
    },
    access: async (token, repo) => {
      down();
      const login = state.people[token.slice(`${kind}-token-`.length)]?.login ?? '';
      state.asked.push(`access:${login}:${repo.id}`);
      return state.levels[login]?.[name(repo)] ?? 'none';
    },
    accessByBot: async (login, repo) => {
      if (state.bot.hang === true) return new Promise<BotAccess>(() => {});
      if (state.bot.down) return 'unreachable';
      state.asked.push(`bot:${login}:${repo.id}`);
      return state.bot.answer ?? state.levels[login]?.[name(repo)] ?? 'none';
    },
    addableRepos: async () => ({ state: 'listed', repos: state.repos }),
    repoById: async (id) => {
      if (state.bot.down) return { state: 'unreachable' };
      const found = state.repos.find((repo) => repo.id === id);
      return found === undefined ? { state: 'gone' } : { state: 'found', repo: found };
    },
    health: async () => (state.bot.down ? 'unreachable' : 'ok'),
    tokenFor: async () => `${kind}-repo-token`,
    selfCheck: async () => ({ ok: true }),
  };
}

export interface TwoHostRig {
  base: string;
  data: string;
  door: FrontDoor;
  table: WikiTable;
  processes: WikiProcesses;
  hosts: Record<HostKeyName, FakeHostState>;
  advance: (ms: number) => void;
  agents: DoorAgents | undefined;
  signIn: (host: HostKeyName, who: string, cookie?: string) => Promise<string>;
  get: (path: string, cookie: string, headers?: Record<string, string>) => Promise<Answer>;
}

const cleanup: Array<() => void | Promise<void>> = [];

export async function cleanUpRigs(): Promise<void> {
  for (const step of cleanup.splice(0).reverse()) await step();
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-two-hosts-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function twoHostRig(
  options: {
    only?: HostKeyName;
    sessionSeconds?: number;
    agents?: boolean;
    connectors?: boolean;
  } = {},
): Promise<TwoHostRig> {
  const data = tempDir();
  const script = join(tempDir(), 'child.cjs');
  writeFileSync(script, CHILD);
  let time = Date.UTC(2026, 10, 24);
  const now = () => time;
  const person = (id: number, login: string): HostPerson => ({
    id,
    login,
    name: login.toUpperCase(),
    avatarUrl: '',
  });
  const state: Record<HostKeyName, FakeHostState> = {
    github: {
      people: { alice: person(11, 'alice'), bob: person(12, 'bob') },
      levels: { alice: { a: 'admin', g: 'write' }, bob: { a: 'write' } },
      repos: [
        { host: 'github', id: 1, owner: 'team', ownerId: 7, name: 'a' },
        { host: 'github', id: 2, owner: 'team', ownerId: 7, name: 'g' },
      ],
      bot: { answer: undefined, down: false },
      asked: [],
    },
    forgejo: {
      people: { alice: person(11, 'alice'), carol: person(13, 'carol') },
      levels: { alice: { a: 'write', f: 'admin' }, carol: { a: 'admin', f: 'write' } },
      repos: [
        { host: 'forgejo', id: 1, owner: 'team', ownerId: 70, name: 'a' },
        { host: 'forgejo', id: 3, owner: 'team', ownerId: 70, name: 'f' },
      ],
      bot: { answer: undefined, down: false },
      asked: [],
    },
  };
  const table = openWikiTable(join(data, 'server', 'wikis.json'));
  const kinds: HostKeyName[] = options.only === undefined ? ['github', 'forgejo'] : [options.only];
  for (const kind of kinds) {
    for (const repo of state[kind].repos) table.add(repo, 'setup', time, kind);
  }
  const settings: FrontDoorSettings = {
    dataDir: data,
    externalUrl: new URL('http://127.0.0.1'),
    sessionSecret: '0123456789abcdef0123456789abcdef',
    sessionMaxAgeSeconds: options.sessionSeconds ?? 3600,
    agentTokenDays: 30,
    mcpConnectors: options.connectors === true,
    accessCheckMs: 300_000,
    wikiIdleMs: 30 * 60_000,
    hosts: [],
  };
  const entries: DoorHostEntry[] = kinds.map((kind, index) => {
    const names =
      kind === 'github' ? gitHubNames() : forgejoNames('{login}@noreply.forgejo.example');
    const hostSettings: HostSettings = {
      key: kind,
      kind,
      label: names.label,
      primary: index === 0,
      webUrl: `https://${kind}.example`,
      apiUrl: `https://${kind}.example/api`,
      clientId: `${kind}-id`,
      clientSecret: `${kind}-secret`,
      githubApp: undefined,
      forgejoBotToken: kind === 'forgejo' ? 'forgejo-bot' : undefined,
      allowedOwners: new Set(['team']),
      serverAdmins: new Set(kind === 'github' ? ['alice'] : ['carol']),
      commitEmailFormat: undefined,
      names,
    };
    const owners: AllowedOwners = { names: hostSettings.allowedOwners, ...table.pinsOn(kind) };
    const host = fakeHost(kind, state[kind]);
    return {
      key: kind,
      settings: hostSettings,
      names,
      host,
      access: createWikiAccess({
        host,
        runnable: () => true,
        refused: (wiki, refusal) => table.disconnect(wiki.key, refusal),
        now,
      }),
      owners,
      paths: doorHostPaths(kind),
    };
  });
  settings.hosts = entries.map((entry) => entry.settings);
  const hosts = doorHosts(entries);
  const processes = createWikiProcesses({
    dataDir: data,
    externalUrl: settings.externalUrl,
    env: { PATH: process.env.PATH },
    cli: [process.execPath, script],
    hostOf: (wiki) => {
      const entry = hosts.of(wiki);
      return entry === undefined
        ? undefined
        : { host: entry.host, owners: entry.owners, settings: entry.settings };
    },
    table,
    tokenSocket: () => '/tmp/none.sock',
    log: silentLog,
    bootstrap: async () => {},
    now,
  });
  cleanup.push(() => processes.stopAll());
  let late: FrontDoor | undefined;
  const server: Server = createServer((req, res) => late?.handleRequest(req, res));
  server.on('upgrade', (req, socket, head) => late?.handleUpgrade(req, socket, head));
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
  settings.externalUrl = new URL(`http://127.0.0.1:${port}`);
  const agents =
    options.agents === true
      ? createDoorAgents({
          settings,
          hosts,
          table,
          processes,
          sessionUser: (req, hostKey) => late?.sessionUser(req, hostKey),
          log: silentLog,
          now,
        })
      : undefined;
  if (agents !== undefined) cleanup.push(() => agents.close());
  const door = createFrontDoor({
    settings,
    hosts,
    table,
    processes,
    ...(agents === undefined ? {} : { agents }),
    mentionCounts: createMentionCounts(data, now),
    log: silentLog,
    now,
    randomState: () => 'state-1',
    listDeadlineMs: 300,
  });
  door.setReady(true);
  late = door;
  const base = `http://127.0.0.1:${port}`;
  const get = (path: string, cookie: string, headers: Record<string, string> = {}) =>
    httpFetch(`${base}${path}`, { headers: { cookie, ...headers } });
  return {
    base,
    data,
    door,
    table,
    processes,
    agents,
    hosts: state,
    advance: (ms) => {
      time += ms;
    },
    get,
    signIn: async (host, who, cookie = '') => {
      const start = await get(`/auth/${host}/login?next=%2F`, cookie);
      const stateCookie = cookiesOf(start).find((c) => c.startsWith('gq_oauth_state')) ?? '';
      const back = await get(
        `/auth/${host}/callback?code=${who}&state=state-1`,
        [cookie, stateCookie].filter((part) => part !== '').join('; '),
      );
      if (back.status !== 302) throw new Error(`sign-in failed: ${back.status}`);
      return cookiesOf(back).find((c) => c.startsWith('gq_session=')) ?? '';
    },
  };
}
