import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type MemoryUse,
  MIN_IDLE_BEFORE_MAKING_ROOM_MS,
  ServerBusyError,
} from '../process-pool/memory.ts';
import { createDraftInstances } from './instances.ts';
import type { DraftRecord } from './model.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function record(slug: string): DraftRecord {
  return {
    slug,
    branch: `draft/${slug}`,
    title: slug,
    base: 'main',
    baseSha: 'abc',
    author: { id: 1, login: 'a' },
    createdAt: '',
    updatedAt: '',
    status: 'draft',
    reviews: [],
    requests: [],
  };
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];
  kill(signal: string) {
    this.signals.push(signal);
    this.signalCode = signal;
    setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  options: { readyAfter?: number; memory?: () => MemoryUse | undefined; now?: () => number } = {},
) {
  const baseDir = mkdtempSync(join(tmpdir(), 'gq-instances-'));
  dirs.push(baseDir);
  const spawned: Array<{
    args: readonly string[];
    env: Record<string, string | undefined>;
    child: FakeChild;
  }> = [];
  const prepared: string[] = [];
  let polls = 0;
  const instances = createDraftInstances({
    baseDir,
    cli: ['node', 'cli.mjs'],
    internalSecret: 's'.repeat(64),
    log: silentLog,
    prepare: async (draft, dir) => {
      prepared.push(draft.slug);
      mkdirSync(join(dir, '.git'), { recursive: true });
    },
    spawn: (_command, args, options) => {
      const child = new FakeChild();
      spawned.push({ args, env: options.env, child });
      return child as unknown as ChildProcess;
    },
    socketDir: baseDir,
    memory: options.memory ?? (() => undefined),
    now: options.now,
    get: async (socket, path) => {
      if (path === '/api/gitquire/stop-state') {
        return { status: 200, body: JSON.stringify({ pushedAndClean: !socket.includes('dirty') }) };
      }
      polls += 1;
      return { status: polls > (options.readyAfter ?? 0) ? 200 : 503, body: '' };
    },
    env: {
      KEEP: 'yes',
      PORT: '8080',
      GITQUIRE_HOST_TOKEN: 'bot-token',
      GITQUIRE_HOST_TOKEN_FILE: '/run/t',
    },
  });
  return { instances, spawned, prepared, baseDir };
}

describe('draft editors', () => {
  it('prepares and starts one editor per draft, even when asked twice at once', async () => {
    const { instances, spawned, prepared, baseDir } = setup({ readyAfter: 2 });
    const [a, b] = await Promise.all([
      instances.ensure(record('plan')),
      instances.ensure(record('plan')),
    ]);
    expect(a).toBe(join(baseDir, 'plan.sock'));
    expect(b).toBe(a);
    expect(prepared).toEqual(['plan']);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(['cli.mjs', 'start']);
    expect(spawned[0]?.env).toMatchObject({
      KEEP: 'yes',
      GITQUIRE_SOCKET: a,
      GITQUIRE_BIND: '127.0.0.1',
      GITQUIRE_DRAFT: 'plan',
      GITQUIRE_BRANCH: 'draft/plan',
      GITQUIRE_INTERNAL_SECRET: 's'.repeat(64),
    });
    expect(spawned[0]?.env).not.toHaveProperty('PORT');
    expect(spawned[0]?.env.GITQUIRE_HOST_TOKEN).toBeUndefined();
    expect(spawned[0]?.env.GITQUIRE_HOST_TOKEN_FILE).toBeUndefined();
    expect(instances.isRunning('plan')).toBe(true);
  });

  it('reports pushed and clean only when every running draft does', async () => {
    const { instances } = setup();
    expect(await instances.stopState()).toEqual({ pushedAndClean: true });
    await instances.ensure(record('plan'));
    expect(await instances.stopState()).toEqual({ pushedAndClean: true });
    await instances.ensure(record('dirty-notes'));
    expect(await instances.stopState()).toEqual({ pushedAndClean: false });
  });

  it('puts an idle draft to sleep before starting another when memory is tight, else answers busy', async () => {
    let time = 0;
    let used = 0;
    const { instances, spawned } = setup({
      memory: () => ({ usedBytes: used, limitBytes: 1000 }),
      now: () => time,
    });
    await instances.ensure(record('old'));
    const release = instances.hold('old');
    time = MIN_IDLE_BEFORE_MAKING_ROOM_MS * 2;
    used = 900;
    await expect(instances.ensure(record('new'))).rejects.toBeInstanceOf(ServerBusyError);
    expect(instances.isRunning('new')).toBe(false);
    release();
    time += MIN_IDLE_BEFORE_MAKING_ROOM_MS;
    const sleeping = spawned[0]?.child;
    sleeping?.once('exit', () => {
      used = 500;
    });
    await instances.ensure(record('new'));
    expect(instances.isRunning('old')).toBe(false);
    expect(instances.isRunning('new')).toBe(true);
  });

  it('stops an editor with SIGTERM and starts it again on demand', async () => {
    const { instances, spawned } = setup();
    await instances.ensure(record('plan'));
    await instances.stop('plan');
    expect(spawned[0]?.child.signals).toEqual(['SIGTERM']);
    expect(instances.isRunning('plan')).toBe(false);
    await instances.ensure(record('plan'));
    expect(spawned).toHaveLength(2);
  });

  it('runs work for one draft one after another', async () => {
    const { instances } = setup();
    const order: string[] = [];
    const slow = instances.exclusive('plan', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first');
    });
    const fast = instances.exclusive('plan', async () => {
      order.push('second');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['first', 'second']);
  });

  it('reports an editor that exits while starting', async () => {
    const { instances, spawned } = setup({ readyAfter: 1000 });
    const starting = instances.ensure(record('plan'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    spawned[0]?.child.emit('exit', 1, null);
    await expect(starting).rejects.toThrow('stopped while starting');
  });
});
