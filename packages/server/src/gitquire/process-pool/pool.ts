import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import { internalRequestHeaders } from '../internal-request.ts';

type Env = Record<string, string | undefined>;

export const SOCKET_ENV = 'GITQUIRE_SOCKET';
export const STOP_STATE_PATH = '/api/gitquire/stop-state';
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 300;
const DEFAULT_STOP_GRACE_MS = 25_000;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const SWEEP_MS = 60_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Env; stdio: 'inherit' },
) => ChildProcess;

export interface SocketAnswer {
  status: number;
  body: string;
}

export type SocketGet = (socketPath: string, path: string) => Promise<SocketAnswer>;

export interface ChildSpec {
  cwd: string;
  env: Env;
}

export interface ProcessPoolDeps {
  label: string;
  cli: readonly string[];
  log: GateLogger;
  socketDir?: string;
  makeSocketDir?: () => string;
  spawn?: SpawnFn;
  get?: SocketGet;
  idleMs?: number;
  stopGraceMs?: number;
  now?: () => number;
}

interface Running {
  child: ChildProcess;
  socket: string;
  ready: Promise<string>;
  exited: Promise<void>;
  lastUsed: number;
  holds: number;
}

export interface StopState {
  pushedAndClean: boolean;
}

export interface ProcessPool {
  socketPath: (id: string) => string;
  ensure: (id: string, start: () => Promise<ChildSpec>) => Promise<string>;
  touch: (id: string) => void;
  hold: (id: string) => () => void;
  isRunning: (id: string) => boolean;
  running: () => string[];
  stop: (id: string) => Promise<void>;
  halt: (id: string) => Promise<void>;
  exclusive: <T>(id: string, work: () => Promise<T>) => Promise<T>;
  stopState: (id: string) => Promise<StopState | undefined>;
  stopAll: () => Promise<void>;
}

export function createPrivateSocketDir(): string {
  return mkdtempSync(join(tmpdir(), 'gq-'));
}

export function socketGet(socketPath: string, path: string): Promise<SocketAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, method: 'GET', headers: internalRequestHeaders() },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('No answer in time.')));
    req.end();
  });
}

export function parseStopState(answer: SocketAnswer): StopState | undefined {
  if (answer.status !== 200) return undefined;
  try {
    const value = JSON.parse(answer.body) as { pushedAndClean?: unknown };
    return typeof value.pushedAndClean === 'boolean'
      ? { pushedAndClean: value.pushedAndClean }
      : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createProcessPool(deps: ProcessPoolDeps): ProcessPool {
  const spawn: SpawnFn =
    deps.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options));
  const get = deps.get ?? socketGet;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const now = deps.now ?? Date.now;
  let socketDir = deps.socketDir;
  const ownsSocketDir = deps.socketDir === undefined;
  let closing = false;
  const entries = new Map<string, Running>();
  const queues = new Map<string, Promise<unknown>>();
  const pending = new Map<string, Promise<string>>();
  const tag = `[gitquire-${deps.label}]`;

  function socketFolder(): string {
    socketDir ??= (deps.makeSocketDir ?? createPrivateSocketDir)();
    return socketDir;
  }

  function socketFor(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`"${id}" cannot name a process.`);
    return join(socketFolder(), `${id}.sock`);
  }

  function removeSocketDir(): void {
    if (ownsSocketDir && socketDir !== undefined)
      rmSync(socketDir, { recursive: true, force: true });
  }

  function refuseWhenClosing(id: string): void {
    if (closing)
      throw new Error(`The ${deps.label} process "${id}" cannot start while GitQuire stops.`);
  }

  function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.catch(() => undefined);
    queues.set(id, settled);
    void settled.then(() => {
      if (queues.get(id) === settled) queues.delete(id);
    });
    return next;
  }

  async function waitReady(id: string, socket: string, exited: Promise<void>): Promise<string> {
    let gone = false;
    void exited.then(() => {
      gone = true;
    });
    const deadline = now() + READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (gone) throw new Error(`The ${deps.label} process "${id}" stopped while starting.`);
      const ok = await get(socket, '/readyz').then(
        (answer) => answer.status >= 200 && answer.status < 300,
        () => false,
      );
      if (ok) return socket;
      await delay(READY_POLL_MS);
    }
    throw new Error(`The ${deps.label} process "${id}" did not start in time.`);
  }

  async function stopEntry(entry: Running): Promise<void> {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
    entry.child.kill('SIGTERM');
    const timer = delay(stopGraceMs).then(() => 'timeout' as const);
    if ((await Promise.race([entry.exited.then(() => 'exited' as const), timer])) === 'timeout') {
      entry.child.kill('SIGKILL');
      await entry.exited;
    }
  }

  async function start(id: string, spec: () => Promise<ChildSpec>): Promise<string> {
    refuseWhenClosing(id);
    const socket = socketFor(id);
    const { cwd, env } = await spec();
    refuseWhenClosing(id);
    const [command, ...args] = deps.cli;
    if (command === undefined)
      throw new Error(`GitQuire does not know how to start a ${deps.label} process.`);
    rmSync(socket, { force: true });
    const childEnv: Env = { ...env, [SOCKET_ENV]: socket };
    delete childEnv.PORT;
    const child = spawn(command, [...args, 'start'], { cwd, env: childEnv, stdio: 'inherit' });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    const entry: Running = {
      child,
      socket,
      exited,
      ready: Promise.resolve(socket),
      lastUsed: now(),
      holds: 0,
    };
    entry.ready = waitReady(id, socket, exited);
    entries.set(id, entry);
    void exited.then(() => {
      if (entries.get(id) === entry) entries.delete(id);
      rmSync(socket, { force: true });
      deps.log.info({ id }, `${tag} process stopped`);
    });
    deps.log.info({ id }, `${tag} starting process`);
    try {
      return await entry.ready;
    } catch (err) {
      await stopEntry(entry);
      throw err;
    }
  }

  function ensure(id: string, spec: () => Promise<ChildSpec>): Promise<string> {
    if (closing) {
      return Promise.reject(
        new Error(`The ${deps.label} process "${id}" cannot start while GitQuire stops.`),
      );
    }
    const existing = entries.get(id);
    if (existing !== undefined) {
      existing.lastUsed = now();
      return existing.ready;
    }
    const inFlight = pending.get(id);
    if (inFlight !== undefined) return inFlight;
    const started = exclusive(id, () => {
      const again = entries.get(id);
      return again === undefined ? start(id, spec) : again.ready;
    });
    pending.set(id, started);
    const clear = () => {
      if (pending.get(id) === started) pending.delete(id);
    };
    started.then(clear, clear);
    return started;
  }

  async function halt(id: string): Promise<void> {
    const entry = entries.get(id);
    if (entry === undefined) return;
    entries.delete(id);
    await stopEntry(entry);
  }

  async function stopState(id: string): Promise<StopState | undefined> {
    const entry = entries.get(id);
    if (entry === undefined) return { pushedAndClean: true };
    return get(entry.socket, STOP_STATE_PATH).then(parseStopState, () => undefined);
  }

  process.once('exit', () => {
    for (const entry of entries.values()) {
      if (entry.child.exitCode === null && entry.child.signalCode === null)
        entry.child.kill('SIGTERM');
    }
    removeSocketDir();
  });

  const sweep = setInterval(() => {
    for (const [id, entry] of entries) {
      if (entry.holds === 0 && now() - entry.lastUsed > idleMs) {
        deps.log.info({ id }, `${tag} stopping an idle process`);
        void exclusive(id, () => halt(id));
      }
    }
  }, SWEEP_MS);
  sweep.unref();

  return {
    socketPath: socketFor,
    ensure,
    touch: (id) => {
      const entry = entries.get(id);
      if (entry !== undefined) entry.lastUsed = now();
    },
    hold: (id) => {
      const entry = entries.get(id);
      if (entry === undefined) return () => {};
      entry.holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.holds--;
        entry.lastUsed = now();
      };
    },
    isRunning: (id) => entries.has(id),
    running: () => [...entries.keys()],
    stop: (id) => exclusive(id, () => halt(id)),
    halt,
    exclusive,
    stopState,
    stopAll: async () => {
      closing = true;
      clearInterval(sweep);
      await Promise.allSettled([...pending.values(), ...queues.values()]);
      await Promise.all([...entries.keys()].map((id) => halt(id)));
      removeSocketDir();
    },
  };
}
