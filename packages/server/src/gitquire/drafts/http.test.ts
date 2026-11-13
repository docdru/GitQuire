import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '../access-gate.ts';
import { runGitSync } from '../repo-bootstrap.ts';
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
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      state.status = status;
      state.headers = { ...extra, ...headers };
      res.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) state.body += chunk;
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

beforeEach(() => {
  repos = createTestRepos({ 'hello.md': '# Hello\n' });
  const instances = fakeInstances(repos);
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
    agentOwner: () => undefined,
    secure: false,
    log: silentLog,
  });
});

afterEach(() => repos.cleanup());

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
});
