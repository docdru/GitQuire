import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import { INTERNAL_SECRET_ENV } from '../internal-request.ts';
import {
  createProcessPool,
  type ProcessPool,
  type SocketGet,
  type SpawnFn,
  type StopState,
} from '../process-pool/pool.ts';
import { DRAFT_BASE_ENV, DRAFT_SLUG_ENV, DRAFT_TITLE_ENV } from '../workspace.ts';
import type { DraftRecord } from './model.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const DRAFT_INSTANCE_ENV = DRAFT_SLUG_ENV;
const STOP_GRACE_MS = 20_000;
export const STOP_DEADLINE_ENV = 'GITQUIRE_STOP_DEADLINE_MS';
const BEHIND_DRAFT_STOP_DEADLINE_MS = 25_000;
const BEHIND_DRAFT_STOP_GRACE_MS = 30_000;

export interface DraftInstancesDeps {
  baseDir: string;
  projectName?: string;
  cli: readonly string[];
  env: Env;
  internalSecret: string;
  log: GateLogger;
  behindFrontDoor?: boolean;
  prepare: (draft: DraftRecord, dir: string) => Promise<void>;
  stillOpen?: (slug: string) => boolean;
  spawn?: SpawnFn;
  get?: SocketGet;
  socketDir?: string;
  idleMs?: number;
  now?: () => number;
}

export interface DraftInstances {
  dir: (slug: string) => string;
  ensure: (draft: DraftRecord) => Promise<string>;
  touch: (slug: string) => void;
  hold: (slug: string) => () => void;
  isRunning: (slug: string) => boolean;
  stop: (slug: string) => Promise<void>;
  remove: (slug: string) => Promise<void>;
  halt: (slug: string) => Promise<void>;
  prepareDir: (draft: DraftRecord) => Promise<void>;
  erase: (slug: string) => Promise<void>;
  exclusive: <T>(slug: string, work: () => Promise<T>) => Promise<T>;
  stopState: () => Promise<StopState | undefined>;
  stopAll: () => Promise<void>;
}

export function createDraftInstances(deps: DraftInstancesDeps): DraftInstances {
  const pool: ProcessPool = createProcessPool({
    label: 'drafts',
    cli: deps.cli,
    log: deps.log,
    socketDir: deps.socketDir,
    spawn: deps.spawn,
    get: deps.get,
    idleMs: deps.idleMs,
    stopGraceMs: deps.behindFrontDoor === true ? BEHIND_DRAFT_STOP_GRACE_MS : STOP_GRACE_MS,
    now: deps.now,
  });
  const folder = deps.projectName ?? 'wiki';
  const dir = (slug: string): string => join(deps.baseDir, slug, basename(folder));

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

  function ensure(draft: DraftRecord): Promise<string> {
    return pool.ensure(draft.slug, async () => {
      if (deps.stillOpen !== undefined && !deps.stillOpen(draft.slug)) {
        throw new Error(`The draft "${draft.slug}" is closed.`);
      }
      await prepareDir(draft);
      return {
        cwd: dir(draft.slug),
        env: {
          ...deps.env,
          GITQUIRE_HOST_TOKEN: undefined,
          GITQUIRE_HOST_TOKEN_FILE: undefined,
          GITQUIRE_BIND: '127.0.0.1',
          GITQUIRE_BRANCH: draft.branch,
          [DRAFT_INSTANCE_ENV]: draft.slug,
          [DRAFT_TITLE_ENV]: draft.title,
          [DRAFT_BASE_ENV]: draft.base,
          [INTERNAL_SECRET_ENV]: deps.internalSecret,
          ...(deps.behindFrontDoor === true
            ? { [STOP_DEADLINE_ENV]: String(BEHIND_DRAFT_STOP_DEADLINE_MS) }
            : {}),
        },
      };
    });
  }

  async function remove(slug: string): Promise<void> {
    await pool.halt(slug);
    rmSync(join(deps.baseDir, slug), { recursive: true, force: true });
  }

  async function stopState(): Promise<StopState | undefined> {
    const states = await Promise.all(pool.running().map((slug) => pool.stopState(slug)));
    if (states.some((state) => state === undefined)) return undefined;
    return { pushedAndClean: states.every((state) => state?.pushedAndClean === true) };
  }

  return {
    dir,
    ensure,
    touch: pool.touch,
    hold: pool.hold,
    isRunning: pool.isRunning,
    stop: pool.stop,
    remove: (slug) => pool.exclusive(slug, () => remove(slug)),
    halt: pool.halt,
    prepareDir,
    erase: remove,
    exclusive: pool.exclusive,
    stopState,
    stopAll: pool.stopAll,
  };
}
