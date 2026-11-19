import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { rawRequest } from '../composition-rig.test-helper.ts';
import { buildIngressPolicy } from '../ingress-policy.ts';
import { loggerFactory } from '../logger.ts';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import { type ContentDispatchOptions, createContentDispatch } from './content-dispatch.ts';
import { createHttpApp } from './http-app.ts';

const servers: Server[] = [];

async function start(options: Partial<ContentDispatchOptions> = {}) {
  const log = loggerFactory.getLogger('content-dispatch-test');
  const legacy = vi.fn(
    (_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      res.writeHead(418);
      res.end('legacy sentinel');
    },
  );
  const app = createHttpApp({
    log,
    legacyDispatch: legacy,
    contentDispatch: createContentDispatch({
      ingressPolicy: buildIngressPolicy({}),
      log,
      ...options,
    }),
  });
  const server = createServer(app.requestListener);
  servers.push(server);
  const { port } = await listenOnLoopback(server);
  return { port, legacy };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('native content fallback ownership and middleware failures', () => {
  test('non-API failures and no-shell hints never traverse legacy dispatch', async () => {
    const { port, legacy } = await start();
    const missing = await rawRequest(port, '/unrecognized');
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('running without the web UI');
    expect(legacy).not.toHaveBeenCalled();
    const api = await rawRequest(port, '/api/remaining');
    expect(api.status).toBe(418);
    expect(api.body).toBe('legacy sentinel');
  });

  test.each(['contentAssetMiddleware', 'reactShellMiddleware'] as const)(
    '%s failure before headers is a problem response',
    async (key) => {
      const { port, legacy } = await start({
        [key]: () => {
          readFileSync('/nonexistent-ok-middleware-failure');
        },
      });
      const response = await rawRequest(port, '/route');
      expect(response.status).toBe(500);
      expect(response.headers['content-type']).toBe('application/problem+json');
      expect(response.body).toContain('urn:ok:error:internal-server-error');
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  test.each(['contentAssetMiddleware', 'reactShellMiddleware'] as const)(
    '%s failure after headers ends only the original bytes',
    async (key) => {
      const { port, legacy } = await start({
        [key]: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.write('partial bytes');
          readFileSync('/nonexistent-ok-middleware-failure');
        },
      });
      const response = await rawRequest(port, '/route');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.body).toBe('partial bytes');
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  test('next after a response cannot append shell bytes', async () => {
    const { port, legacy } = await start({
      contentAssetMiddleware: (_req, res, next) => {
        res.end('content');
        next();
      },
      reactShellMiddleware: (_req, res) => {
        res.end('shell');
      },
    });
    expect((await rawRequest(port, '/route')).body).toBe('content');
    expect(legacy).not.toHaveBeenCalled();
  });

  test('forwarded admission precedes content execution', async () => {
    const { port, legacy } = await start({
      contentAssetMiddleware: (_req, res) => {
        res.end('content reached');
      },
    });
    const forwarded = await rawRequest(port, '/route', {
      headers: { 'X-Forwarded-Host': 'public.example' },
    });
    expect(forwarded.status).toBe(403);
    expect(forwarded.body).toContain('Proxied request refused');
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe('app icons come from the web UI before wiki content', () => {
  test.each([
    '/icons/gitquire-192.png',
    '/icons/gitquire-maskable-512.png',
    '/apple-touch-icon.png',
    '/favicon.ico',
    '/favicon.svg',
    '/manifest.webmanifest',
  ])('%s is served by the shell even when content would answer 404', async (path) => {
    const { port } = await start({
      contentAssetMiddleware: (_req, res) => {
        res.writeHead(404);
        res.end();
      },
      reactShellMiddleware: (_req, res) => {
        res.end('shell icon');
      },
    });
    const response = await rawRequest(port, path);
    expect(response.status).toBe(200);
    expect(response.body).toBe('shell icon');
  });

  test('a wiki file under icons/ still serves when the shell has no such file', async () => {
    const { port } = await start({
      contentAssetMiddleware: (_req, res) => {
        res.end('wiki icon');
      },
      reactShellMiddleware: (_req, _res, next) => next(),
    });
    expect((await rawRequest(port, '/icons/team-logo.png')).body).toBe('wiki icon');
  });

  test('other images keep going to wiki content first', async () => {
    const { port } = await start({
      contentAssetMiddleware: (_req, res) => {
        res.end('wiki image');
      },
      reactShellMiddleware: (_req, res) => {
        res.end('shell');
      },
    });
    expect((await rawRequest(port, '/images/diagram.png')).body).toBe('wiki image');
    expect((await rawRequest(port, '/icons/nested/logo.png')).body).toBe('wiki image');
  });
});

describe('the no-web-UI hint names the running channel CLI', () => {
  afterEach(() => vi.unstubAllEnvs());

  const detailOf = (body: string): string => (JSON.parse(body) as { detail: string }).detail;

  test('Stable keeps its exact gq start detail with and without a content middleware', async () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
    const bare = await start();
    expect(detailOf((await rawRequest(bare.port, '/unrecognized')).body)).toBe(
      'This server is running without the web UI. Restart it with plain `gq start` to serve the editor. No handler for /unrecognized',
    );
    const contentOnly = await start({ contentAssetMiddleware: (_req, _res, next) => next() });
    expect(detailOf((await rawRequest(contentOnly.port, '/unrecognized')).body)).toBe(
      'This server is running without the web UI. Restart it with plain `gq start` to serve the editor. No handler for /unrecognized',
    );
  });

  test('Beta names gq-beta start with and without a content middleware', async () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    const bare = await start();
    expect(detailOf((await rawRequest(bare.port, '/unrecognized')).body)).toContain(
      'Restart it with plain `gq-beta start` to serve the editor.',
    );
    const contentOnly = await start({ contentAssetMiddleware: (_req, _res, next) => next() });
    expect(detailOf((await rawRequest(contentOnly.port, '/unrecognized')).body)).toContain(
      'Restart it with plain `gq-beta start` to serve the editor.',
    );
  });
});
