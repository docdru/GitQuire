import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateLogger } from '../access-gate.ts';
import { DOOR_TOKEN_PATH } from '../door-token.ts';
import type { HostRepoRef } from '../host/types.ts';
import { pathOf, sendJson } from '../http-util.ts';
import { INTERNAL_REQUEST_HEADER } from '../internal-request.ts';

export const DOOR_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

export interface TokenSocketDeps {
  wikiOfSecret: (secret: string) => string | undefined;
  repoOf: (key: string) => HostRepoRef | undefined;
  tokenFor: (repo: HostRepoRef) => Promise<string | undefined>;
  log: GateLogger;
  now?: () => number;
}

function createTokenHandler(
  deps: TokenSocketDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const now = deps.now ?? Date.now;
  return (req, res) => {
    if (pathOf(req).path !== DOOR_TOKEN_PATH || req.method !== 'GET') {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    const secret = req.headers[INTERNAL_REQUEST_HEADER];
    const key = typeof secret === 'string' ? deps.wikiOfSecret(secret) : undefined;
    const repo = key === undefined ? undefined : deps.repoOf(key);
    if (key === undefined || repo === undefined) {
      sendJson(res, 403, { error: 'unknown-wiki' });
      return;
    }
    deps.tokenFor(repo).then(
      (token) => {
        if (token === undefined) {
          deps.log.warn({ wiki: key }, '[gitquire-wikis] no host token for a wiki');
          sendJson(res, 503, { error: 'no-token' });
          return;
        }
        sendJson(res, 200, { token, expiresAt: now() + DOOR_TOKEN_LIFETIME_MS });
      },
      (err: unknown) => {
        deps.log.warn({ err, wiki: key }, '[gitquire-wikis] host token lookup failed');
        sendJson(res, 503, { error: 'no-token' });
      },
    );
  };
}

export interface TokenSocket {
  path: string;
  close: () => Promise<void>;
}

export async function listenTokenSocket(deps: TokenSocketDeps): Promise<TokenSocket> {
  const dir = mkdtempSync(join(tmpdir(), 'gq-door-'));
  const path = join(dir, 'door.sock');
  const server: Server = createServer(createTokenHandler(deps));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  return {
    path,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
