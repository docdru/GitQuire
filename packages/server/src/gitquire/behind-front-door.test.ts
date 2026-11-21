import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collabUrlFromRequestHeaders } from '../collab-bootstrap-url.ts';
import type { AccessGate, SessionUser } from './access-gate.ts';
import { createAccessGateFromEnv } from './index.ts';
import { INTERNAL_REQUEST_HEADER, internalRequestHeaders } from './internal-request.ts';
import { sessionPrincipal, setSessionPrincipalResolver } from './principal-directory.ts';
import {
  encodeProxiedUser,
  FORWARDED_PREFIX_HEADER,
  PROXIED_PRINCIPAL_HEADER,
  requestPrefix,
} from './request-person.ts';
import { setAdminResolver } from './settings-admin.ts';
import { encodeSigned } from './signed-cookie.ts';

const PREFIX = '/w/team/wiki';
const PEOPLE: Record<string, SessionUser> = {
  alice: { id: 42, login: 'alice', name: 'Alice', avatarUrl: '' },
  boss: { id: 7, login: 'boss', name: 'Boss', avatarUrl: '', repoAdmin: true },
};
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

let gate: AccessGate;
let editor: Server;
let frontDoor: Server;
let editorPort: number;
let frontDoorPort: number;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

function editorHandler(req: IncomingMessage, res: ServerResponse): void {
  if (gate.handleRequest(req, res)) return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      path: req.url,
      principal: sessionPrincipal(req)?.login ?? null,
      admin: gate.isAdminRequest(req),
      collabUrl: collabUrlFromRequestHeaders(req.headers, requestPrefix(req)),
    }),
  );
}

function frontDoorHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith('x-gitquire-') || name === 'cookie') continue;
    headers[name] = value;
  }
  const who = /(?:^|;\s*)front=([a-z]+)/.exec(req.headers.cookie ?? '')?.[1];
  const person = who === undefined ? undefined : PEOPLE[who];
  return {
    ...headers,
    ...internalRequestHeaders(),
    [FORWARDED_PREFIX_HEADER]: PREFIX,
    ...(person === undefined ? {} : { [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser(person) }),
  };
}

function frontDoorHandler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';
  if (!url.startsWith(`${PREFIX}/`)) {
    res.writeHead(404).end();
    return;
  }
  const upstream = request(
    {
      host: '127.0.0.1',
      port: editorPort,
      method: req.method,
      path: url.slice(PREFIX.length),
      headers: frontDoorHeaders(req),
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  req.pipe(upstream);
}

async function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, unknown>; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const text = await res.text();
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function rawRequest(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = Object.entries({
        host: `127.0.0.1:${port}`,
        connection: 'close',
        ...headers,
      }).map(([name, value]) => `${name}: ${value}`);
      socket.write(`GET ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    });
    let answer = '';
    socket.on('data', (chunk) => {
      answer += chunk.toString();
    });
    socket.on('close', () => resolve(answer.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

function upgrade(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = Object.entries({
        host: `127.0.0.1:${port}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        ...headers,
      }).map(([name, value]) => `${name}: ${value}`);
      socket.write(`GET ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    });
    let answer = '';
    socket.on('data', (chunk) => {
      answer += chunk.toString();
    });
    socket.on('close', () => resolve(answer.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

beforeAll(async () => {
  gate = createAccessGateFromEnv(
    {
      GITQUIRE_BEHIND_FRONT_DOOR: '1',
      GITQUIRE_REPO: 'team/wiki',
      GITQUIRE_ADMINS: 'boss',
      GITHUB_APP_CLIENT_ID: 'Iv1.client',
    },
    { externalUrl: undefined },
    silentLog,
  ) as AccessGate;
  editor = createServer(editorHandler);
  editor.on('upgrade', (req: IncomingMessage, socket) => {
    if (!gate.admitUpgrade(req, socket)) return;
    socket.end('HTTP/1.1 418 Admitted\r\nConnection: close\r\n\r\n');
  });
  editorPort = await listen(editor);
  frontDoor = createServer(frontDoorHandler);
  frontDoor.on('upgrade', (req: IncomingMessage, socket) => {
    const upstream = connect(editorPort, '127.0.0.1', () => {
      const headers = frontDoorHeaders(req);
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${String(value)}`);
      upstream.write(
        `GET ${(req.url ?? '/').slice(PREFIX.length)} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`,
      );
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  frontDoorPort = await listen(frontDoor);
});

afterAll(async () => {
  setSessionPrincipalResolver(undefined);
  setAdminResolver(undefined);
  await new Promise((resolve) => frontDoor.close(resolve));
  await new Promise((resolve) => editor.close(resolve));
});

describe('an editor process behind the front door', () => {
  it('answers health checks without the secret', async () => {
    expect((await get(editorPort, '/healthz')).status).toBe(200);
    expect((await get(editorPort, '/readyz')).status).toBe(200);
  });

  it('refuses everything else that does not come through the front door, cookie or not', async () => {
    const cookie = `gq_session=${encodeSigned('x'.repeat(40), { v: 1, ...PEOPLE.boss, exp: 9e9 })}`;
    for (const path of ['/', '/api/documents', '/auth/me', '/auth/github/login', '/mcp']) {
      const direct = await get(editorPort, path, { cookie, accept: 'text/html' });
      expect(direct.status).toBe(403);
      expect(direct.json).toEqual({ error: 'front-door-only' });
    }
    const forged = await get(editorPort, '/api/documents', {
      [INTERNAL_REQUEST_HEADER]: 'guess',
      [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser(PEOPLE.boss),
    });
    expect(forged.status).toBe(403);
  });

  it('passes health checks only at their exact address', async () => {
    expect((await get(editorPort, '/healthz?x=1')).status).toBe(200);
    for (const path of ['//x/healthz', '/a/../healthz', '/healthz/']) {
      const out = await rawRequest(editorPort, path, {});
      expect(out).not.toContain('200');
    }
  });

  it('refuses a /collab address that reads differently once normalised', async () => {
    for (const path of ['/x/../collab', '//collab', '/collab/../api/documents']) {
      expect(await rawRequest(editorPort, path, {})).toContain('400');
      expect(await upgrade(editorPort, path, {})).toContain('400');
    }
  });

  it('refuses a websocket upgrade that does not come through the front door', async () => {
    expect(await upgrade(editorPort, '/collab', {})).toContain('403');
    expect(await upgrade(editorPort, '/something-else', {})).toContain('403');
  });

  it('knows the person the front door forwards, for pages and for the global hooks', async () => {
    const page = await get(frontDoorPort, `${PREFIX}/notes`, { cookie: 'front=alice' });
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ path: '/notes', principal: 'alice', admin: false });
    const admin = await get(frontDoorPort, `${PREFIX}/notes`, { cookie: 'front=boss' });
    expect(admin.json).toMatchObject({ principal: 'boss', admin: true });
  });

  it('builds the live-editing address with the prefix', async () => {
    const page = await get(frontDoorPort, `${PREFIX}/api/config`, {
      cookie: 'front=alice',
      'x-forwarded-proto': 'https',
    });
    expect(page.json.collabUrl).toBe(`wss://127.0.0.1:${frontDoorPort}${PREFIX}/collab`);
  });

  it('answers /auth/me from the forwarded person with the per-wiki admin flag, and sets no cookie', async () => {
    const me = await get(frontDoorPort, `${PREFIX}/auth/me`, { cookie: 'front=boss' });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({
      login: 'boss',
      admin: true,
      admins: { logins: ['boss'], repo: 'team/wiki' },
      features: { canUseTokens: false, canConnect: false },
    });
    expect(me.headers['set-cookie']).toBeUndefined();
    const alice = await get(frontDoorPort, `${PREFIX}/auth/me`, { cookie: 'front=alice' });
    expect(alice.json).toMatchObject({ login: 'alice', admin: false });
    const nobody = await get(frontDoorPort, `${PREFIX}/auth/me`);
    expect(nobody.status).toBe(401);
  });

  it('has no sign-in routes of its own', async () => {
    for (const path of ['/auth/github/login', '/auth/github/callback', '/auth/logout']) {
      const out = await get(frontDoorPort, `${PREFIX}${path}`, { accept: 'text/html' });
      expect(out.status).toBe(404);
      expect(out.headers['set-cookie']).toBeUndefined();
      expect(out.headers.location).toBeUndefined();
    }
  });

  it('sends pages without a person back as not signed in, without a redirect or cookie', async () => {
    const out = await get(frontDoorPort, `${PREFIX}/notes`, { accept: 'text/html' });
    expect(out.status).toBe(401);
    expect(out.headers.location).toBeUndefined();
    expect(out.headers['set-cookie']).toBeUndefined();
  });

  it('keeps admin-only calls for the wiki admins the front door names', async () => {
    const alice = await fetch(`http://127.0.0.1:${frontDoorPort}${PREFIX}/api/local-op/sync`, {
      method: 'POST',
      headers: { cookie: 'front=alice' },
    });
    expect(alice.status).toBe(403);
    const boss = await fetch(`http://127.0.0.1:${frontDoorPort}${PREFIX}/api/local-op/sync`, {
      method: 'POST',
      headers: { cookie: 'front=boss' },
    });
    expect(boss.status).toBe(200);
  });

  it('admits live editing only with a person', async () => {
    expect(await upgrade(frontDoorPort, `${PREFIX}/collab`, { cookie: 'front=alice' })).toContain(
      '418',
    );
    expect(await upgrade(frontDoorPort, `${PREFIX}/collab`, {})).toContain('401');
  });
});
