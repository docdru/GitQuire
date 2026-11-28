import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { proxyRequest } from './forward.ts';
import {
  createPrivateSocketDir,
  createProcessPool,
  DEFAULT_PROCESS_HEAP_MB,
  type ProcessPool,
  processHeapMb,
  socketGet,
} from './pool.ts';
import { listenOnUnixSocket, unixSocketFromEnv } from './socket-listener.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const CHILD = `
const http = require('node:http');
const socket = process.env.GITQUIRE_SOCKET;
const server = http.createServer((req, res) => {
  if (req.url === '/api/gitquire/stop-state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pushedAndClean: process.env.DIRTY !== '1' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/heap') {
    res.end(JSON.stringify({ execArgv: process.execArgv, limitMb: Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 1048576) }));
    return;
  }
  res.end(JSON.stringify({ url: req.url, port: process.env.PORT ?? null, args: process.argv.slice(2) }));
});
server.listen(socket);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-pool-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pool(made: string[] = [], heapMb?: number): ProcessPool {
  const scripts = tempDir();
  const script = join(scripts, 'child.cjs');
  writeFileSync(script, CHILD);
  const created = createProcessPool({
    label: 'test',
    cli: [process.execPath, script],
    log: silentLog,
    stopGraceMs: 5000,
    heapMb,
    makeSocketDir: () => {
      const dir = createPrivateSocketDir();
      made.push(dir);
      return dir;
    },
  });
  cleanup.push(async () => {
    await created.stopAll();
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  return created;
}

describe('process pool', () => {
  it('keeps its sockets in a private folder', () => {
    const dir = createPrivateSocketDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('starts a child on its own unix socket, never on a port', async () => {
    const children = pool();
    const cwd = tempDir();
    const socket = await children.ensure('alpha', async () => ({
      cwd,
      env: { ...process.env, PORT: '8080' },
    }));
    expect(socket).toBe(children.socketPath('alpha'));
    const answer = await socketGet(socket, '/hello');
    expect(JSON.parse(answer.body)).toEqual({ url: '/hello', port: null, args: ['start'] });
    expect(children.isRunning('alpha')).toBe(true);
  });

  it('starts a child with the heap limit it was given', async () => {
    const children = pool([], 192);
    const cwd = tempDir();
    const socket = await children.ensure('small', async () => ({ cwd, env: { ...process.env } }));
    const limit = JSON.parse((await socketGet(socket, '/heap')).body) as {
      execArgv: string[];
      limitMb: number;
    };
    expect(limit.execArgv).toContain('--max-old-space-size=192');
    expect(limit.limitMb).toBeGreaterThanOrEqual(192);
    expect(limit.limitMb).toBeLessThan(1024);
    expect(JSON.parse((await socketGet(socket, '/x')).body).args).toEqual(['start']);
  });

  it('reads the heap setting: 256 MB by default, 0 for none, refuses nonsense', () => {
    expect(processHeapMb({})).toBe(DEFAULT_PROCESS_HEAP_MB);
    expect(DEFAULT_PROCESS_HEAP_MB).toBe(256);
    expect(processHeapMb({ GITQUIRE_PROCESS_HEAP_MB: ' 384 ' })).toBe(384);
    expect(processHeapMb({ GITQUIRE_PROCESS_HEAP_MB: '0' })).toBeUndefined();
    expect(processHeapMb({ GITQUIRE_PROCESS_HEAP_MB: 'off' })).toBeUndefined();
    for (const bad of ['12', '1.5', 'lots', '-1']) {
      expect(() => processHeapMb({ GITQUIRE_PROCESS_HEAP_MB: bad })).toThrow(
        /GITQUIRE_PROCESS_HEAP_MB/,
      );
    }
  });

  it('stops a process nobody holds after the idle time, or sooner once its last holder left', async () => {
    const scripts = tempDir();
    const script = join(scripts, 'child.cjs');
    writeFileSync(script, CHILD);
    let time = 0;
    const children = createProcessPool({
      label: 'test',
      cli: [process.execPath, script],
      log: silentLog,
      stopGraceMs: 5000,
      idleMs: 30_000,
      closedIdleMs: 10_000,
      now: () => time,
    });
    cleanup.push(() => children.stopAll());
    const cwd = tempDir();
    const spec = async () => ({ cwd, env: { ...process.env } });
    await children.ensure('agent', spec);
    await children.ensure('people', spec);
    const release = children.hold('people');
    time = 20_000;
    release();
    time = 25_000;
    children.sweep();
    expect(children.isRunning('agent')).toBe(true);
    expect(children.isRunning('people')).toBe(true);
    time = 30_001;
    children.sweep();
    await children.exclusive('people', async () => {});
    await children.exclusive('agent', async () => {});
    expect(children.isRunning('people')).toBe(false);
    expect(children.isRunning('agent')).toBe(false);
  });

  it('asks a child whether it is pushed and clean', async () => {
    const children = pool();
    const cwd = tempDir();
    await children.ensure('clean', async () => ({ cwd, env: { ...process.env } }));
    await children.ensure('dirty', async () => ({ cwd, env: { ...process.env, DIRTY: '1' } }));
    expect(await children.stopState('clean')).toEqual({ pushedAndClean: true });
    expect(await children.stopState('dirty')).toEqual({ pushedAndClean: false });
    expect(await children.stopState('not-running')).toEqual({ pushedAndClean: true });
  });

  it('stops children in order and waits for them', async () => {
    const children = pool();
    const cwd = tempDir();
    const socket = await children.ensure('alpha', async () => ({ cwd, env: { ...process.env } }));
    await children.stopAll();
    expect(children.isRunning('alpha')).toBe(false);
    await expect(socketGet(socket, '/hello')).rejects.toThrow();
  });

  it('makes its socket folder only when it starts a child, and removes it when it stops', async () => {
    const made: string[] = [];
    const children = pool(made);
    expect(made).toEqual([]);
    const cwd = tempDir();
    await children.ensure('alpha', async () => ({ cwd, env: { ...process.env } }));
    expect(made).toHaveLength(1);
    await children.stopAll();
    expect(existsSync(made[0] ?? '')).toBe(false);
  });

  it('waits for a start that is under way, and refuses new starts once stopping', async () => {
    const children = pool();
    const cwd = tempDir();
    const gate = Promise.withResolvers<void>();
    const starting = children.ensure('slow', async () => {
      await gate.promise;
      return { cwd, env: { ...process.env } };
    });
    const stopping = children.stopAll();
    gate.resolve();
    await expect(starting).rejects.toThrow('cannot start while GitQuire stops');
    await stopping;
    expect(children.isRunning('slow')).toBe(false);
    await expect(
      children.ensure('later', async () => ({ cwd, env: { ...process.env } })),
    ).rejects.toThrow('cannot start while GitQuire stops');
  });

  it('refuses an id that cannot name a socket', async () => {
    const children = pool();
    await expect(
      children.ensure('../escape', async () => ({ cwd: tempDir(), env: {} })),
    ).rejects.toThrow('cannot name a process');
  });

  it('forwards a request to a child over its socket', async () => {
    const children = pool();
    const cwd = tempDir();
    const socket = await children.ensure('alpha', async () => ({ cwd, env: { ...process.env } }));
    const front = createServer((req: IncomingMessage, res: ServerResponse) =>
      proxyRequest(req, res, socket),
    );
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => front.close(() => resolve())));
    const address = front.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/through`);
    expect(await res.json()).toMatchObject({ url: '/through' });
  });
});

describe('unix socket listener', () => {
  it('reads its socket from the environment', () => {
    expect(unixSocketFromEnv({})).toBeUndefined();
    expect(unixSocketFromEnv({ GITQUIRE_SOCKET: ' ' })).toBeUndefined();
    expect(unixSocketFromEnv({ GITQUIRE_SOCKET: '/tmp/gq-x/a.sock' })).toBe('/tmp/gq-x/a.sock');
  });

  it('serves the primary server’s handlers, only to its owner, as a loopback peer', async () => {
    const primary: Server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ peer: req.socket.remoteAddress ?? null }));
    });
    const socket = join(tempDir(), 'editor.sock');
    const server = await listenOnUnixSocket(primary, socket, createServer);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    const answer = await socketGet(socket, '/');
    expect(JSON.parse(answer.body)).toEqual({ peer: '127.0.0.1' });
  });
});
