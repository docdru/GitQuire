import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { GateLogger } from '../access-gate.ts';
import { DOOR_TOKEN_SOCKET_ENV } from '../door-token.ts';
import { repoChange } from '../host/renames.ts';
import type { DoorHost, Refusal } from '../host/types.ts';
import { INTERNAL_REQUEST_HEADER, INTERNAL_SECRET_ENV } from '../internal-request.ts';
import {
  createProcessPool,
  type ProcessPool,
  type SocketAnswer,
  type SocketGet,
  type SpawnFn,
  socketGet,
} from '../process-pool/pool.ts';
import { safeEqual } from '../signed-cookie.ts';
import { type AllowedOwners, ownerAllowed } from './allowed-owners.ts';
import { type WikiRecord, type WikiTable, wikiDir, wikiPrefix } from './wiki-table.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const WIKI_IDLE_MS = 30 * 60 * 1000;
const WIKI_STOP_GRACE_MS = 55_000;
const SWEEP_MS = 60_000;

const PASSED_SETTINGS = new Set([
  'GITQUIRE_GIT_NAME',
  'GITQUIRE_GIT_EMAIL',
  'GITQUIRE_AI_CHAT',
  'GITQUIRE_ASK_AI',
  'GITQUIRE_ANTHROPIC_BASE_URL',
  'GITQUIRE_MISTRAL_BASE_URL',
  'GITQUIRE_ADMINS',
  'GITQUIRE_SMTP_URL',
  'GITQUIRE_MAIL_FROM',
  'GITQUIRE_MAIL_DOMAINS',
  'GITQUIRE_CHAT_WEBHOOK_URL',
  'GITQUIRE_CHAT_FORMAT',
  'GITQUIRE_SEMANTIC_SEARCH',
  'GITQUIRE_EMBEDDINGS_API_KEY',
  'GITQUIRE_EMBEDDINGS_URL',
  'GITQUIRE_EMBEDDINGS_BASE_URL',
  'GITQUIRE_EMBEDDINGS_MODEL',
  'GITQUIRE_EMBEDDINGS_DIMENSIONS',
  'GITQUIRE_NAMING',
  'GITQUIRE_SYNC_MODE',
  'GITQUIRE_AUTO_SYNC_MODE',
  'GITQUIRE_COMMIT_EMAIL_FORMAT',
  'GITQUIRE_HOST',
  'GITQUIRE_HOST_URL',
  'GITQUIRE_HOST_API_URL',
  'GITQUIRE_GITHUB_WEB_URL',
  'GITQUIRE_GITHUB_API_URL',
  'GITQUIRE_LANG',
  'GITQUIRE_LOG_LEVEL',
  'GITQUIRE_CONSOLE_LEVEL',
  'GITQUIRE_FILE_LEVEL',
  'GITQUIRE_GIT_TIMEOUT_MS',
  'GITQUIRE_SEARCH_MAX_ENTRIES',
  'GITQUIRE_SHOWALL_MAX_ENTRIES',
  'GITQUIRE_CHANNEL',
]);

function isPassed(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith('GITQUIRE_')) return PASSED_SETTINGS.has(upper);
  if (upper.startsWith('GITHUB_') || upper.startsWith('OK_')) return false;
  return true;
}

export function wikiEnv(
  base: Env,
  wiki: WikiRecord,
  options: { externalUrl: URL; secret: string; tokenSocket: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && isPassed(name)) env[name] = value;
  }
  return {
    ...env,
    GITQUIRE_BEHIND_FRONT_DOOR: 'on',
    GITQUIRE_REPO: `${wiki.owner}/${wiki.name}`,
    GITQUIRE_EXTERNAL_URL: `${options.externalUrl.origin}${wikiPrefix(wiki)}`,
    GITQUIRE_ALLOW_EXTERNAL: '1',
    GITQUIRE_BIND: '127.0.0.1',
    [INTERNAL_SECRET_ENV]: options.secret,
    [DOOR_TOKEN_SOCKET_ENV]: options.tokenSocket,
  };
}

type WikiCheck = 'runnable' | 'closed' | 'unreachable';

export interface WikiProcesses {
  ensure: (wiki: WikiRecord) => Promise<string>;
  check: (wiki: WikiRecord) => Promise<WikiCheck>;
  secretOf: (key: string) => string | undefined;
  wikiOfSecret: (secret: string) => string | undefined;
  touch: (key: string) => void;
  hold: (key: string) => () => void;
  isRunning: (key: string) => boolean;
  sweep: () => Promise<void>;
  stopAll: () => Promise<void>;
}

export interface WikiProcessesDeps {
  dataDir: string;
  externalUrl: URL;
  env: Env;
  cli: readonly string[];
  host: Pick<DoorHost, 'repoById' | 'health'>;
  table: WikiTable;
  owners: AllowedOwners;
  tokenSocket: () => string;
  log: GateLogger;
  spawn?: SpawnFn;
  get?: (socket: string, path: string, headers: Record<string, string>) => Promise<SocketAnswer>;
  bootstrap?: (dir: string, env: Record<string, string>) => Promise<void>;
  socketDir?: string;
  idleMs?: number;
  now?: () => number;
}

export class WikiClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiClosedError';
  }
}

function runBootstrap(
  cli: readonly string[],
): (dir: string, env: Record<string, string>) => Promise<void> {
  return (dir, env) =>
    new Promise((resolve, reject) => {
      const [command, ...args] = cli;
      if (command === undefined) {
        reject(new Error('GitQuire does not know how to set up a wiki folder.'));
        return;
      }
      const child: ChildProcess = nodeSpawn(command, [...args, 'gitquire-bootstrap', dir], {
        cwd: dir,
        env,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Setting up the wiki folder ${dir} failed (exit ${code}).`));
      });
    });
}

export function createWikiProcesses(deps: WikiProcessesDeps): WikiProcesses {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? WIKI_IDLE_MS;
  const secrets = new Map<string, string>();
  const bySocket = new Map<string, string>();
  const lastUsed = new Map<string, number>();
  const holds = new Map<string, number>();
  const startedAs = new Map<string, string>();
  const bootstrap = deps.bootstrap ?? runBootstrap(deps.cli);
  const plainGet = deps.get ?? socketGet;

  const get: SocketGet = (socket, path) => {
    const key = bySocket.get(socket);
    const secret = key === undefined ? undefined : secrets.get(key);
    return plainGet(
      socket,
      path,
      secret === undefined ? {} : { [INTERNAL_REQUEST_HEADER]: secret },
    );
  };

  const pool: ProcessPool = createProcessPool({
    label: 'wikis',
    cli: deps.cli,
    log: deps.log,
    socketDir: deps.socketDir,
    spawn: deps.spawn,
    get,
    idleMs: Number.POSITIVE_INFINITY,
    stopGraceMs: WIKI_STOP_GRACE_MS,
    now,
  });

  async function check(wiki: WikiRecord): Promise<WikiCheck> {
    const change = repoChange(wiki, await deps.host.repoById(wiki.id));
    if (change.change === 'unreachable') return wiki.state === 'on' ? 'unreachable' : 'closed';
    if (change.change === 'gone' || change.change === 'mismatch') {
      deps.table.disconnect(wiki.key, 'gone');
      return 'closed';
    }
    if (change.change === 'refused') {
      deps.table.disconnect(wiki.key, change.refusal);
      return 'closed';
    }
    if (change.change === 'renamed') {
      deps.log.info({ wiki: wiki.key, to: change.to }, '[gitquire-wikis] repository renamed');
      deps.table.rename(wiki.key, change.to);
    }
    if (change.change === 'moved') {
      deps.log.info({ wiki: wiki.key, to: change.to }, '[gitquire-wikis] repository moved');
      deps.table.rename(wiki.key, change.to, change.ownerId);
    }
    if (!ownerAllowed(deps.owners, wiki)) {
      deps.table.disconnect(wiki.key, 'owner-not-allowed');
      return 'closed';
    }
    const health = await deps.host.health({ owner: wiki.owner, name: wiki.name });
    if (health === 'unreachable') return wiki.state === 'on' ? 'unreachable' : 'closed';
    if (health !== 'ok') {
      deps.table.disconnect(wiki.key, health.slice('refused:'.length) as Refusal);
      return 'closed';
    }
    if (wiki.state !== 'on') {
      deps.log.info({ wiki: wiki.key }, '[gitquire-wikis] wiki reconnected');
      deps.table.connect(wiki.key);
    }
    return 'runnable';
  }

  function ensure(wiki: WikiRecord): Promise<string> {
    lastUsed.set(wiki.key, now());
    return pool.ensure(wiki.key, async () => {
      const verdict = await check(wiki);
      if (verdict === 'closed' || wiki.state !== 'on') {
        throw new WikiClosedError(`The wiki ${wiki.owner}/${wiki.name} is disconnected.`);
      }
      const dir = wikiDir(deps.dataDir, wiki);
      mkdirSync(dir, { recursive: true });
      const secret = randomBytes(32).toString('hex');
      secrets.set(wiki.key, secret);
      bySocket.set(pool.socketPath(wiki.key), wiki.key);
      const env = wikiEnv(deps.env, wiki, {
        externalUrl: deps.externalUrl,
        secret,
        tokenSocket: deps.tokenSocket(),
      });
      await bootstrap(dir, env);
      startedAs.set(wiki.key, `${wiki.owner}/${wiki.name}`);
      return { cwd: dir, env };
    });
  }

  async function stopIfStoppable(key: string, why: string): Promise<void> {
    const state = await pool.stopState(key);
    if (state?.pushedAndClean !== true) {
      deps.log.info({ wiki: key, why }, '[gitquire-wikis] not stopping: not pushed and clean yet');
      return;
    }
    deps.log.info({ wiki: key, why }, '[gitquire-wikis] stopping a wiki process');
    await pool.stop(key);
  }

  async function sweep(): Promise<void> {
    for (const key of pool.running()) {
      if ((holds.get(key) ?? 0) > 0) continue;
      const wiki = deps.table.byKey(key);
      const renamed = wiki !== undefined && startedAs.get(key) !== `${wiki.owner}/${wiki.name}`;
      const closed = wiki === undefined || wiki.state !== 'on';
      const idle = now() - (lastUsed.get(key) ?? 0) > idleMs;
      if (renamed || closed || idle) {
        await stopIfStoppable(key, renamed ? 'renamed' : closed ? 'disconnected' : 'idle').catch(
          (err: unknown) => deps.log.warn({ err, wiki: key }, '[gitquire-wikis] stop failed'),
        );
      }
    }
  }

  const timer = setInterval(() => {
    void sweep();
  }, SWEEP_MS);
  timer.unref();

  return {
    ensure,
    check,
    secretOf: (key) => secrets.get(key),
    wikiOfSecret: (secret) => {
      for (const [key, value] of secrets) {
        if (safeEqual(value, secret)) return key;
      }
      return undefined;
    },
    touch: (key) => {
      lastUsed.set(key, now());
    },
    hold: (key) => {
      holds.set(key, (holds.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds.set(key, Math.max(0, (holds.get(key) ?? 1) - 1));
        lastUsed.set(key, now());
      };
    },
    isRunning: pool.isRunning,
    sweep,
    stopAll: async () => {
      clearInterval(timer);
      await pool.stopAll();
    },
  };
}
