import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

function setup(options: { readyAfter?: number } = {}) {
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
    env: { KEEP: 'yes' },
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
    fetch: (async () => {
      polls += 1;
      return new Response('', { status: polls > (options.readyAfter ?? 0) ? 200 : 503 });
    }) as typeof fetch,
    freePort: async () => 40000 + spawned.length,
  });
  return { instances, spawned, prepared };
}

describe('draft editors', () => {
  it('prepares and starts one editor per draft, even when asked twice at once', async () => {
    const { instances, spawned, prepared } = setup({ readyAfter: 2 });
    const [a, b] = await Promise.all([
      instances.ensure(record('plan')),
      instances.ensure(record('plan')),
    ]);
    expect(a).toBe(40000);
    expect(b).toBe(40000);
    expect(prepared).toEqual(['plan']);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(['cli.mjs', 'start']);
    expect(spawned[0]?.env).toMatchObject({
      KEEP: 'yes',
      PORT: '40000',
      OK_BIND: '127.0.0.1',
      GITQUIRE_DRAFT: 'plan',
      GITQUIRE_BRANCH: 'draft/plan',
      GITQUIRE_INTERNAL_SECRET: 's'.repeat(64),
    });
    expect(instances.isRunning('plan')).toBe(true);
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
