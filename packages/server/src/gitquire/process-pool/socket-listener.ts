import { chmodSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { SOCKET_ENV } from './pool.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const UNIX_PEER_ADDRESS = '127.0.0.1';

export function unixSocketFromEnv(env: Env): string | undefined {
  const value = env[SOCKET_ENV]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function treatAsLoopbackPeer(socket: Socket): void {
  Object.defineProperty(socket, 'remoteAddress', {
    value: UNIX_PEER_ADDRESS,
    configurable: true,
  });
}

export function listenOnUnixSocket(
  primary: Server,
  socketPath: string,
  createHttpServer: () => Server,
): Promise<Server> {
  const server = createHttpServer();
  server.headersTimeout = primary.headersTimeout;
  server.requestTimeout = primary.requestTimeout;
  server.on('connection', treatAsLoopbackPeer);
  for (const listener of primary.listeners('request')) {
    server.on('request', listener as (...args: unknown[]) => void);
  }
  for (const listener of primary.listeners('upgrade')) {
    server.on('upgrade', listener as (...args: unknown[]) => void);
  }
  rmSync(socketPath, { force: true });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      chmodSync(socketPath, 0o600);
      resolve(server);
    });
  });
}
