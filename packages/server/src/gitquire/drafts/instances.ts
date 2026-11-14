import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import { INTERNAL_SECRET_ENV } from '../internal-request.ts';
import type { DraftRecord } from './model.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const DRAFT_INSTANCE_ENV = 'GITQUIRE_DRAFT';
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 300;
const STOP_GRACE_MS = 20_000;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const SWEEP_MS = 60_000;

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdio: 'inherit';
    windowsHide: true;
  },
) => ChildProcess;

export interface DraftInstancesDeps {
  baseDir: string;
  projectName?: string;
  cli: readonly string[];
  env: Env;
  internalSecret: string;
  log: GateLogger;
  prepare: (draft: DraftRecord, dir: string) => Promise<void>;
  stillOpen?: (slug: string) => boolean;
  spawn?: SpawnFn;
  fetch?: typeof fetch;
  freePort?: () => Promise<number>;
  idleMs?: number;
  now?: () => number;
}

interface Running {
  child: ChildProcess;
  port: number;
  ready: Promise<number>;
  exited: Promise<void>;
  lastUsed: number;
  holds: number;
}

export interface DraftInstances {
  dir: (slug: string) => string;
  ensure: (draft: DraftRecord) => Promise<number>;
  touch: (slug: string) => void;
  hold: (slug: string) => () => void;
  isRunning: (slug: string) => boolean;
  stop: (slug: string) => Promise<void>;
  remove: (slug: string) => Promise<void>;
  halt: (slug: string) => Promise<void>;
  prepareDir: (draft: DraftRecord) => Promise<void>;
  erase: (slug: string) => Promise<void>;
  exclusive: <T>(slug: string, work: () => Promise<T>) => Promise<T>;
  stopAll: () => Promise<void>;
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('No free port.'))));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDraftInstances(deps: DraftInstancesDeps): DraftInstances {
  const spawn: SpawnFn =
    deps.spawn ??
    ((command, args, options) => nodeSpawn(command, [...args], { ...options, windowsHide: true }));
  const doFetch = deps.fetch ?? fetch;
  const freePort = deps.freePort ?? findFreePort;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const now = deps.now ?? Date.now;
  const running = new Map<string, Running>();
  const queues = new Map<string, Promise<unknown>>();
  const pending = new Map<string, Promise<number>>();

  const folder = deps.projectName ?? 'wiki';
  const dir = (slug: string): string => join(deps.baseDir, slug, basename(folder));

  function exclusive<T>(slug: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(slug) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.catch(() => undefined);
    queues.set(slug, settled);
    void settled.then(() => {
      if (queues.get(slug) === settled) queues.delete(slug);
    });
    return next;
  }

  async function waitReady(slug: string, port: number, exited: Promise<void>): Promise<number> {
    let gone = false;
    void exited.then(() => {
      gone = true;
    });
    const deadline = now() + READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (gone) throw new Error(`The draft "${slug}" stopped while starting.`);
      const ok = await doFetch(`http://127.0.0.1:${port}/readyz`).then(
        (res) => res.ok,
        () => false,
      );
      if (ok) return port;
      await delay(READY_POLL_MS);
    }
    throw new Error(`The draft "${slug}" did not start in time.`);
  }

  async function prepareDir(draft: DraftRecord): Promise<void> {
    const target = dir(draft.slug);
    if (existsSync(join(target, '.git'))) return;
    try {
      await deps.prepare(draft, target);
    } catch (err) {
      rmSync(target, { recursive: true, force: true });
      throw err;
    }
  }

  async function start(draft: DraftRecord): Promise<number> {
    if (deps.stillOpen !== undefined && !deps.stillOpen(draft.slug)) {
      throw new Error(`The draft "${draft.slug}" is closed.`);
    }
    const target = dir(draft.slug);
    await prepareDir(draft);
    const port = await freePort();
    const [command, ...args] = deps.cli;
    if (command === undefined) throw new Error('GitQuire does not know how to start a draft.');
    const child = spawn(command, [...args, 'start'], {
      cwd: target,
      env: {
        ...deps.env,
        PORT: String(port),
        OK_BIND: '127.0.0.1',
        GITQUIRE_BRANCH: draft.branch,
        [DRAFT_INSTANCE_ENV]: draft.slug,
        [INTERNAL_SECRET_ENV]: deps.internalSecret,
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    const entry: Running = {
      child,
      port,
      exited,
      ready: Promise.resolve(port),
      lastUsed: now(),
      holds: 0,
    };
    entry.ready = waitReady(draft.slug, port, exited);
    running.set(draft.slug, entry);
    void exited.then(() => {
      if (running.get(draft.slug) === entry) running.delete(draft.slug);
      deps.log.info({ draft: draft.slug }, '[gitquire-drafts] draft editor stopped');
    });
    deps.log.info({ draft: draft.slug, port }, '[gitquire-drafts] starting draft editor');
    try {
      return await entry.ready;
    } catch (err) {
      await stopEntry(entry);
      throw err;
    }
  }

  function ensure(draft: DraftRecord): Promise<number> {
    const existing = running.get(draft.slug);
    if (existing !== undefined) {
      existing.lastUsed = now();
      return existing.ready;
    }
    const inFlight = pending.get(draft.slug);
    if (inFlight !== undefined) return inFlight;
    const started = exclusive(draft.slug, () => {
      const again = running.get(draft.slug);
      return again === undefined ? start(draft) : again.ready;
    });
    pending.set(draft.slug, started);
    const clear = () => {
      if (pending.get(draft.slug) === started) pending.delete(draft.slug);
    };
    started.then(clear, clear);
    return started;
  }

  async function stopEntry(entry: Running): Promise<void> {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
    entry.child.kill('SIGTERM');
    const timer = delay(STOP_GRACE_MS).then(() => 'timeout' as const);
    if ((await Promise.race([entry.exited.then(() => 'exited' as const), timer])) === 'timeout') {
      entry.child.kill('SIGKILL');
      await entry.exited;
    }
  }

  async function stop(slug: string): Promise<void> {
    const entry = running.get(slug);
    if (entry === undefined) return;
    running.delete(slug);
    await stopEntry(entry);
  }

  async function remove(slug: string): Promise<void> {
    await stop(slug);
    rmSync(join(deps.baseDir, slug), { recursive: true, force: true });
  }

  process.once('exit', () => {
    for (const entry of running.values()) {
      if (entry.child.exitCode === null && entry.child.signalCode === null)
        entry.child.kill('SIGTERM');
    }
  });

  const sweep = setInterval(() => {
    for (const [slug, entry] of running) {
      if (entry.holds === 0 && now() - entry.lastUsed > idleMs) {
        deps.log.info({ draft: slug }, '[gitquire-drafts] stopping an idle draft editor');
        void exclusive(slug, () => stop(slug));
      }
    }
  }, SWEEP_MS);
  sweep.unref();

  return {
    dir,
    ensure,
    touch: (slug) => {
      const entry = running.get(slug);
      if (entry !== undefined) entry.lastUsed = now();
    },
    hold: (slug) => {
      const entry = running.get(slug);
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
    isRunning: (slug) => running.has(slug),
    stop: (slug) => exclusive(slug, () => stop(slug)),
    remove: (slug) => exclusive(slug, () => remove(slug)),
    halt: stop,
    prepareDir,
    erase: remove,
    exclusive,
    stopAll: async () => {
      clearInterval(sweep);
      await Promise.all([...running.keys()].map((slug) => stop(slug)));
    },
  };
}
