import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasUnsafeHeader, proxyRequest, proxyUpgrade } from './forward.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function listen(server: Server, socket?: string): Promise<number> {
  await new Promise<void>((resolve) =>
    socket === undefined
      ? server.listen(0, '127.0.0.1', () => resolve())
      : server.listen(socket, () => resolve()),
  );
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

async function rig(extra: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'gq-forward-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, 'up.sock');
  const reached: string[] = [];
  const closed: string[] = [];
  const upstream = createServer((req, res) => {
    reached.push(`http ${req.url}`);
    res.end('ok');
  });
  upstream.on('upgrade', (req, s) => {
    reached.push(`upgrade ${req.url}`);
    s.on('end', () => s.end());
    s.on('error', () => {});
    s.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
  });
  await listen(upstream, socket);
  const front = createServer((req, res) => proxyRequest(req, res, socket, { extraHeaders: extra }));
  front.on('upgrade', (req, s, head) =>
    proxyUpgrade(req, s, head, socket, () => closed.push(String(req.url)), extra),
  );
  const port = await listen(front);
  return { port, reached, closed, front };
}

function upgrade(port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    let text = '';
    s.on('data', (chunk) => {
      text += String(chunk);
    });
    s.on('close', () => resolve(text.split('\r\n')[0] ?? ''));
    s.write('GET /collab HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    setTimeout(() => s.end(), 300);
  });
}

function get(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path: '/page' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on('error', reject);
    r.end();
  });
}

describe('forwarding to a child socket', () => {
  it('finds CR, LF and NUL in header names and values', () => {
    expect(hasUnsafeHeader({ a: 'b', c: ['d', 'e'] })).toBe(false);
    expect(hasUnsafeHeader({ a: 'b\r\nx-gitquire-principal: forged' })).toBe(true);
    expect(hasUnsafeHeader({ a: ['ok', 'b\n'] })).toBe(true);
    expect(hasUnsafeHeader({ 'a\0': 'b' })).toBe(true);
  });

  it('refuses a websocket and a request whose headers would inject lines, before reaching the child', async () => {
    const { port, reached } = await rig({
      'x-gitquire-view': 'd1\r\nx-gitquire-principal: forged',
    });
    expect(await upgrade(port)).toBe('HTTP/1.1 400 Bad Request');
    expect(await get(port)).toBe(400);
    expect(reached).toEqual([]);
  });

  it('forwards safe headers as before', async () => {
    const { port, reached } = await rig({ 'x-gitquire-view': 'd1' });
    expect(await upgrade(port)).toBe('HTTP/1.1 101 Switching Protocols');
    expect(await get(port)).toBe(200);
    expect(reached).toEqual(['upgrade /collab', 'http /page']);
  });

  it('closes both sides and lets go when the browser ends a live-editing connection', async () => {
    const { port, closed, front } = await rig({});
    const line = await new Promise<string>((resolve) => {
      const s = connect(port, '127.0.0.1');
      s.once('data', (chunk) => {
        resolve(String(chunk).split('\r\n')[0] ?? '');
        s.destroy();
      });
      s.write(
        'GET /collab HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    });
    expect(line).toBe('HTTP/1.1 101 Switching Protocols');
    for (let i = 0; i < 50 && closed.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(closed).toEqual(['/collab']);
    const open = await new Promise<number>((resolve) =>
      front.getConnections((_e, n) => resolve(n)),
    );
    expect(open).toBe(0);
  });
});
