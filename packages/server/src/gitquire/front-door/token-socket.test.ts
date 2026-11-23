import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchDoorToken, parseDoorToken } from '../door-token.ts';
import { internalSecret } from '../internal-request.ts';
import { DOOR_TOKEN_LIFETIME_MS, listenTokenSocket, type TokenSocket } from './token-socket.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const sockets: TokenSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
});

function ask(path: string, secret: string, socket: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: socket, path, headers: { 'x-gitquire-internal': secret } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('token socket of the front door', () => {
  it('hands each wiki process the token for its own repository only, found by its secret', async () => {
    const mine = internalSecret();
    const socket = await listenTokenSocket({
      wikiOfSecret: (secret) =>
        secret === mine ? 'github-1' : secret === 'b' ? 'github-2' : undefined,
      repoOf: (key) => (key === 'github-1' ? { owner: 'team', name: 'a' } : undefined),
      tokenFor: async (repo) => `token-for-${repo.name}`,
      log: silentLog,
      now: () => 1000,
    });
    sockets.push(socket);
    await expect(fetchDoorToken(socket.path)).resolves.toEqual({
      token: 'token-for-a',
      expiresAt: 1000 + DOOR_TOKEN_LIFETIME_MS,
    });
    expect(await ask('/token', 'unknown', socket.path)).toBe(403);
    expect(await ask('/token', 'b', socket.path)).toBe(403);
    expect(await ask('/other', mine, socket.path)).toBe(404);
  });

  it('answers 503 without a token, which the wiki reads as "try again"', async () => {
    const socket = await listenTokenSocket({
      wikiOfSecret: () => 'github-1',
      repoOf: () => ({ owner: 'team', name: 'a' }),
      tokenFor: async () => undefined,
      log: silentLog,
    });
    sockets.push(socket);
    await expect(fetchDoorToken(socket.path)).rejects.toThrow(/no token/);
    expect(parseDoorToken(200, '{"token":"t","expiresAt":5}')).toEqual({
      token: 't',
      expiresAt: 5,
    });
    expect(parseDoorToken(200, '{"token":""}')).toBeUndefined();
    expect(parseDoorToken(503, '{}')).toBeUndefined();
  });
});
