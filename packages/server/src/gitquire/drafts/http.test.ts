import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Duplex, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '../access-gate.ts';
import {
  INTERNAL_REQUEST_HEADER,
  internalRequestHeaders,
  isInternalRequest,
} from '../internal-request.ts';
import { runGitSync } from '../repo-bootstrap.ts';
import {
  encodeProxiedUser,
  FORWARDED_PREFIX_HEADER,
  FORWARDED_VIEW_HEADER,
  PROXIED_PRINCIPAL_HEADER,
  proxiedUser,
} from '../request-person.ts';
import { createDraftsHttp, type DraftsHttp } from './http.ts';
import { plainGitRemote } from './remote.ts';
import { createDraftService, type DraftService } from './service.ts';
import { createDraftStore } from './store.ts';
import { createTestRepos, fakeInstances, type TestRepos } from './test-repo.test-helper.ts';

const ALICE: SessionUser = { id: 42, login: 'alice', name: 'Alice A', avatarUrl: '' };
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

interface FakeResponse {
  status: number | undefined;
  headers: Record<string, unknown>;
  body: string;
  done: Promise<void>;
  res: ServerResponse;
}

function fakeResponse(): FakeResponse {
  const { promise: done, resolve } = Promise.withResolvers<void>();
  const state = { status: undefined, headers: {}, body: '', done } as unknown as FakeResponse;
  const extra: Record<string, unknown> = {};
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: unknown) {
      extra[name] = value;
    },
    on() {
      return res;
    },
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      state.status = status;
      state.headers = { ...extra, ...headers };
      res.headersSent = true;
      return res;
    },
    write(chunk: string | Buffer) {
      state.body += chunk.toString();
      return true;
    },
    once() {
      return res;
    },
    emit() {
      return false;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) state.body += chunk.toString();
      res.writableEnded = true;
      resolve();
      return res;
    },
  };
  state.res = res as unknown as ServerResponse;
  return state;
}

function fakeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): IncomingMessage {
  const body = init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))];
  return Object.assign(Readable.from(body), {
    url,
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...init.headers },
  }) as unknown as IncomingMessage;
}

let repos: TestRepos;
let service: DraftService;
let http: DraftsHttp;
let signedIn: SessionUser | undefined;
let agent: SessionUser | undefined;
let draftInstance: Server;
let draftSocket: string;
let haltGate: Promise<void> | undefined;

beforeEach(async () => {
  agent = undefined;
  haltGate = undefined;
  draftInstance = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'mcp-session-id': 'session-in-draft',
      'x-seen-internal': String(isInternalRequest(req)),
      'x-seen-person': proxiedUser(req)?.login ?? '',
      'x-seen-prefix': String(req.headers[FORWARDED_PREFIX_HEADER] ?? ''),
    });
    res.end(`draft instance saw ${req.url}`);
  });
  repos = createTestRepos({ 'hello.md': '# Hello\n' });
  draftSocket = join(repos.root, 'draft.sock');
  await new Promise<void>((resolve) => draftInstance.listen(draftSocket, resolve));
  const prepared = fakeInstances(repos);
  const instances = {
    ...prepared,
    ensure: async (draft: Parameters<typeof prepared.ensure>[0]) => {
      await prepared.ensure(draft);
      return draftSocket;
    },
    halt: async (slug: string) => {
      await prepared.halt(slug);
      await haltGate;
    },
  };
  service = createDraftService({
    projectDir: repos.live,
    store: createDraftStore(join(repos.root, 'drafts.json')),
    instances,
    remote: plainGitRemote(repos.live, runGitSync, () => ({})),
    runGit: runGitSync,
    authEnv: () => ({}),
    baseBranch: async () => 'main',
    log: silentLog,
  });
  signedIn = ALICE;
  http = createDraftsHttp({
    service,
    instances,
    sessionUser: () => signedIn,
    agentOwner: () => agent,
    secure: false,
    log: silentLog,
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => draftInstance.close(() => resolve()));
  repos.cleanup();
});

async function call(url: string, init: Parameters<typeof fakeRequest>[1] = {}) {
  const out = fakeResponse();
  const handled = http.handleRequest(fakeRequest(url, init), out.res);
  if (handled) await out.done;
  return { handled, ...out, json: () => JSON.parse(out.body) as Record<string, unknown> };
}

describe('drafts HTTP', () => {
  it('needs a signed-in person', async () => {
    signedIn = undefined;
    const out = await call('/api/gitquire/drafts');
    expect(out.status).toBe(401);
  });

  it('creates a draft and opens it for the person who made it', async () => {
    const out = await call('/api/gitquire/drafts', { method: 'POST', body: { title: 'Plan' } });
    expect(out.status).toBe(201);
    expect(out.headers['Set-Cookie']).toContain('gq_view=plan');
    const list = await call('/api/gitquire/drafts', { headers: { cookie: 'gq_view=plan' } });
    expect(list.json()).toMatchObject({ enabled: true, me: 'alice', viewing: 'plan' });
  });

  it('refuses cross-origin changes', async () => {
    const out = await call('/api/gitquire/drafts', {
      method: 'POST',
      body: { title: 'Plan' },
      headers: { origin: 'https://evil.example', host: 'wiki.example' },
    });
    expect(out.status).toBe(403);
  });

  it('opens a draft from a ?draft= link and drops the parameter', async () => {
    await service.create(ALICE, 'Plan');
    const out = await call('/notes?draft=plan&x=1', { headers: { accept: 'text/html' } });
    expect(out.status).toBe(302);
    expect(out.headers.Location).toBe('/notes?x=1');
    expect(out.headers['Set-Cookie']).toContain('gq_view=plan');
    const live = await call('/?draft=live', { headers: { accept: 'text/html' } });
    expect(live.headers['Set-Cookie']).toContain('gq_view=; Max-Age=0');
  });

  it('leaves the live wiki alone when no draft is open', async () => {
    expect((await call('/api/documents')).handled).toBe(false);
    expect((await call('/auth/me', { headers: { cookie: 'gq_view=plan' } })).handled).toBe(false);
  });

  it('never lets a closed draft fall through to the live wiki', async () => {
    const draft = await service.create(ALICE, 'Plan');
    await service.discard(draft.slug, ALICE);
    const api = await call('/api/documents', { headers: { cookie: 'gq_view=plan' } });
    expect(api.status).toBe(409);
    expect(api.json()).toMatchObject({ error: 'draft-closed' });
    const page = await call('/notes', { headers: { cookie: 'gq_view=plan', accept: 'text/html' } });
    expect(page.status).toBe(302);
    expect(page.headers['Set-Cookie']).toContain('Max-Age=0');
    const current = await call('/api/gitquire/drafts/current', {
      headers: { cookie: 'gq_view=plan' },
    });
    expect(current.json()).toMatchObject({
      viewing: null,
      closed: { slug: 'plan', status: 'discarded' },
    });
  });

  it('sends a page in a closed draft back to its own path, never to another host', async () => {
    const draft = await service.create(ALICE, 'Plan');
    await service.discard(draft.slug, ALICE);
    const out = await call('//evil.example/x?y=1', {
      headers: { cookie: 'gq_view=plan', accept: 'text/html' },
    });
    expect(out.status).toBe(302);
    expect(out.headers.Location).toBe('/x?y=1');
  });

  it('says a draft is closing while it is being published, and turns away new editors', async () => {
    const draft = await service.create(ALICE, 'Plan');
    await call('/api/documents', { headers: { cookie: 'gq_view=plan' } });
    const { promise, resolve } = Promise.withResolvers<void>();
    haltGate = promise;
    const publishing = service.publish(draft.slug, ALICE).catch(() => undefined);
    await new Promise((settle) => setTimeout(settle, 20));
    const current = await call('/api/gitquire/drafts/current', {
      headers: { cookie: 'gq_view=plan' },
    });
    expect(current.json()).toMatchObject({ viewing: { slug: 'plan' }, closing: true });

    const written: string[] = [];
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    socket.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof socket.write;
    const handled = http.handleUpgrade(
      fakeRequest('/collab', { headers: { cookie: 'gq_view=plan', upgrade: 'websocket' } }),
      socket,
      Buffer.alloc(0),
    );
    expect(handled).toBe(true);
    expect(written.join('')).toContain('503');

    resolve();
    await publishing;
    const after = await call('/api/gitquire/drafts/current', {
      headers: { cookie: 'gq_view=plan' },
    });
    expect(after.json()).toMatchObject({ closing: false });
  });

  it('says an open draft that nobody is closing is not closing', async () => {
    await service.create(ALICE, 'Plan');
    const current = await call('/api/gitquire/drafts/current', {
      headers: { cookie: 'gq_view=plan' },
    });
    expect(current.json()).toMatchObject({ viewing: { slug: 'plan' }, closing: false });
  });

  it('keeps the agent setting per person', async () => {
    const put = await call('/api/gitquire/drafts/agent-mode', {
      method: 'PUT',
      body: { mode: 'draft' },
    });
    expect(put.json()).toEqual({ mode: 'draft' });
    const bad = await call('/api/gitquire/drafts/agent-mode', {
      method: 'PUT',
      body: { mode: 'x' },
    });
    expect(bad.status).toBe(400);
  });

  it('reports a clear error code for a draft without changes', async () => {
    await service.create(ALICE, 'Plan');
    const out = await call('/api/gitquire/drafts/plan/ready', {
      method: 'POST',
      body: { logins: ['bob'] },
    });
    expect(out.status).toBe(409);
    expect(out.json()).toMatchObject({ error: 'no-changes' });
    const bad = await call('/api/gitquire/drafts/plan/ready', {
      method: 'POST',
      body: { logins: ['no spaces'] },
    });
    expect(bad.status).toBe(400);
  });

  it('sends an assistant to the live wiki while its person is there', async () => {
    agent = ALICE;
    await service.create(ALICE, 'Plan');
    await call('/api/gitquire/drafts');
    expect((await call('/mcp', { method: 'POST' })).handled).toBe(false);
  });

  it('sends a new assistant session into the draft its person has open', async () => {
    agent = ALICE;
    await service.create(ALICE, 'Plan');
    await call('/api/gitquire/drafts', { headers: { cookie: 'gq_view=plan' } });
    const out = await call('/mcp', { method: 'POST' });
    expect(out.handled).toBe(true);
    expect(out.body).toBe('draft instance saw /mcp');
  });

  it('keeps a session where it started when its person looks elsewhere', async () => {
    agent = ALICE;
    await service.create(ALICE, 'Plan');
    await call('/api/gitquire/drafts', { headers: { cookie: 'gq_view=plan' } });
    await call('/mcp', { method: 'POST' });
    await call('/api/gitquire/drafts');
    const inDraft = await call('/mcp', {
      method: 'POST',
      headers: { 'mcp-session-id': 'session-in-draft' },
    });
    expect(inDraft.body).toBe('draft instance saw /mcp');

    await call('/api/gitquire/drafts', { headers: { cookie: 'gq_view=plan' } });
    const startedLive = await call('/mcp', {
      method: 'POST',
      headers: { 'mcp-session-id': 'session-in-live' },
    });
    expect(startedLive.handled).toBe(false);
  });

  it('follows the AI chat when it asks for the live wiki, even with a draft open', async () => {
    agent = ALICE;
    await service.create(ALICE, 'Plan');
    await call('/api/gitquire/drafts', { headers: { cookie: 'gq_view=plan' } });
    const out = await call('/mcp', {
      method: 'POST',
      headers: { ...internalRequestHeaders(), 'x-gitquire-edits': 'live' },
    });
    expect(out.handled).toBe(false);
  });

  it('follows the AI chat when it asks for a draft, whatever the setting says', async () => {
    agent = ALICE;
    const out = await call('/mcp', {
      method: 'POST',
      headers: { ...internalRequestHeaders(), 'x-gitquire-edits': 'draft' },
    });
    expect(out.handled).toBe(true);
    expect(service.list().some((draft) => draft.agent)).toBe(true);
    expect(service.agentMode(ALICE.id)).toBe('live');
  });

  it('puts the AI chat into the draft its person has open when it asks for a draft', async () => {
    agent = ALICE;
    await service.create(ALICE, 'Plan');
    await call('/api/gitquire/drafts', { headers: { cookie: 'gq_view=plan' } });
    const out = await call('/mcp', {
      method: 'POST',
      headers: { ...internalRequestHeaders(), 'x-gitquire-edits': 'draft' },
    });
    expect(out.body).toBe('draft instance saw /mcp');
    expect(service.list().some((draft) => draft.agent)).toBe(false);
  });

  it('puts a session into the draft the front door names, while its person is elsewhere', async () => {
    agent = ALICE;
    await service.create(ALICE, 'Plan');
    await call('/api/gitquire/drafts');
    const out = await call('/mcp', {
      method: 'POST',
      headers: {
        ...internalRequestHeaders(),
        'x-gitquire-edits': 'draft',
        'x-gitquire-edits-draft': 'plan',
      },
    });
    expect(out.body).toBe('draft instance saw /mcp');
    expect(service.list().some((draft) => draft.agent)).toBe(false);
  });

  it('refuses a named draft that is not open instead of sending it to the live wiki', async () => {
    agent = ALICE;
    const out = await call('/mcp', {
      method: 'POST',
      headers: {
        ...internalRequestHeaders(),
        'x-gitquire-edits': 'draft',
        'x-gitquire-edits-draft': 'nothing-here',
      },
    });
    expect(out.handled).toBe(true);
    expect(out.status).toBe(409);
    expect(service.list()).toEqual([]);
  });

  it('ignores a named draft that does not come from GitQuire itself', async () => {
    agent = ALICE;
    await service.create(ALICE, 'Plan');
    const out = await call('/mcp', {
      method: 'POST',
      headers: { 'x-gitquire-edits-draft': 'plan' },
    });
    expect(out.handled).toBe(false);
  });

  it('ignores an edit choice that does not come from GitQuire itself', async () => {
    agent = ALICE;
    const out = await call('/mcp', { method: 'POST', headers: { 'x-gitquire-edits': 'draft' } });
    expect(out.handled).toBe(false);
  });

  it('puts a new session into the assistant draft when asked from the live wiki', async () => {
    agent = ALICE;
    await call('/api/gitquire/drafts/agent-mode', { method: 'PUT', body: { mode: 'draft' } });
    const out = await call('/mcp', { method: 'POST' });
    expect(out.handled).toBe(true);
    expect(service.list().some((draft) => draft.agent)).toBe(true);
  });
});

describe('drafts HTTP behind the front door', () => {
  const fromFrontDoor = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...internalRequestHeaders(),
    [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser(ALICE),
    [FORWARDED_PREFIX_HEADER]: '/w/team/wiki',
    ...extra,
  });

  beforeEach(() => {
    http = createDraftsHttp({
      service,
      instances: {
        ...fakeInstances(repos),
        ensure: async () => draftSocket,
      },
      sessionUser: proxiedUser,
      agentOwner: proxiedUser,
      secure: true,
      behindFrontDoor: true,
      log: silentLog,
    });
  });

  it('hands the chosen draft back in a header and sets no cookie', async () => {
    const out = await call('/api/gitquire/drafts', {
      method: 'POST',
      body: { title: 'Plan' },
      headers: fromFrontDoor(),
    });
    expect(out.status).toBe(201);
    expect(out.headers['Set-Cookie']).toBeUndefined();
    expect(out.headers[FORWARDED_VIEW_HEADER]).toBe('plan');
    const leave = await call('/api/gitquire/view', {
      method: 'POST',
      body: { slug: null },
      headers: fromFrontDoor({ [FORWARDED_VIEW_HEADER]: 'plan' }),
    });
    expect(leave.headers['Set-Cookie']).toBeUndefined();
    expect(leave.headers[FORWARDED_VIEW_HEADER]).toBe('');
  });

  it('reads the open draft from the front door, not from the cookie', async () => {
    await service.create(ALICE, 'Plan');
    const byCookie = await call('/api/gitquire/drafts', {
      headers: fromFrontDoor({ cookie: 'gq_view=plan' }),
    });
    expect(byCookie.json()).toMatchObject({ viewing: null });
    const byHeader = await call('/api/gitquire/drafts', {
      headers: fromFrontDoor({ [FORWARDED_VIEW_HEADER]: 'plan' }),
    });
    expect(byHeader.json()).toMatchObject({ viewing: 'plan' });
    const forged = await call('/api/gitquire/drafts', {
      headers: {
        ...fromFrontDoor(),
        [INTERNAL_REQUEST_HEADER]: 'guess',
        [FORWARDED_VIEW_HEADER]: 'plan',
      },
    });
    expect(forged.status).toBe(401);
  });

  it('keeps the address prefix in its redirects', async () => {
    await service.create(ALICE, 'Plan');
    const out = await call('/notes?draft=plan&x=1', {
      headers: fromFrontDoor({ accept: 'text/html' }),
    });
    expect(out.status).toBe(302);
    expect(out.headers.Location).toBe('/w/team/wiki/notes?x=1');
    expect(out.headers[FORWARDED_VIEW_HEADER]).toBe('plan');
  });

  it('passes the person, the secret and the prefix on to the draft', async () => {
    await service.create(ALICE, 'Plan');
    const out = await call('/api/documents', {
      headers: fromFrontDoor({ [FORWARDED_VIEW_HEADER]: 'plan' }),
    });
    expect(out.body).toBe('draft instance saw /api/documents');
    expect(out.headers['x-seen-internal']).toBe('true');
    expect(out.headers['x-seen-person']).toBe('alice');
    expect(out.headers['x-seen-prefix']).toBe('/w/team/wiki');
  });

  it('passes the person and the secret on a live-editing upgrade', async () => {
    await service.create(ALICE, 'Plan');
    const seen = Promise.withResolvers<IncomingMessage>();
    draftInstance.on('upgrade', (req, socket) => {
      seen.resolve(req);
      socket.destroy();
    });
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const handled = http.handleUpgrade(
      fakeRequest('/collab', {
        headers: fromFrontDoor({
          [FORWARDED_VIEW_HEADER]: 'plan',
          upgrade: 'websocket',
          connection: 'Upgrade',
        }),
      }),
      socket,
      Buffer.alloc(0),
    );
    expect(handled).toBe(true);
    const upstream = await seen.promise;
    expect(isInternalRequest(upstream)).toBe(true);
    expect(proxiedUser(upstream)?.login).toBe('alice');
    expect(upstream.headers[FORWARDED_PREFIX_HEADER]).toBe('/w/team/wiki');
    expect(upstream.headers[FORWARDED_VIEW_HEADER]).toBeUndefined();
  });
});
