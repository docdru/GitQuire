import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '../access-gate.ts';
import { listenOnUnixSocket } from '../process-pool/socket-listener.ts';
import { createChatHistoryStore } from './history.ts';
import { createChatKeyStore } from './key-store.ts';
import { localChatKeys, localChatUsage } from './person-data.ts';
import { type ChatProviders, ProviderError, type ProviderTurn } from './providers.ts';
import { type ChatRoutes, createChatRoutes } from './routes.ts';
import { createChatUsageStore } from './usage.ts';
import type { OpenWikiTools } from './wiki-tools.ts';

const ALICE: SessionUser = { id: 7, login: 'alice', name: 'Alice', avatarUrl: '' };
const BOB: SessionUser = { id: 8, login: 'bob', name: 'Bob', avatarUrl: '' };
const silentLog = { info() {}, warn() {}, error() {} };

interface Harness {
  url: string;
  routes: ChatRoutes;
  toolCalls: { user: string; name: string; input: Record<string, unknown> }[];
  checkedKeys: string[];
  opened: (string | undefined)[];
  ports: number[];
  server: Server;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(options: {
  turns?: ProviderTurn[];
  checkKey?: (key: string) => void;
  writeResult?: { output: string; isError: boolean };
  ownPort?: number;
}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gq-chat-routes-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const turns = [...(options.turns ?? [])];
  const toolCalls: Harness['toolCalls'] = [];
  const checkedKeys: string[] = [];
  const providers: ChatProviders = {
    async turn() {
      const next = turns.shift();
      if (next === undefined) throw new ProviderError('overloaded', 'Overloaded.', 529);
      return next;
    },
    async checkKey(_provider, key) {
      checkedKeys.push(key);
      options.checkKey?.(key);
    },
  };
  const opened: Harness['opened'] = [];
  const ports: number[] = [];
  const openTools: OpenWikiTools = async (user, port, _signal, edits) => {
    opened.push(edits);
    ports.push(port);
    return openedTools(user);
  };
  const openedTools = (user: Parameters<OpenWikiTools>[0]) => ({
    specs: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
    async call(name, input) {
      toolCalls.push({ user: user.login, name, input });
      if (name === 'write' && options.writeResult !== undefined) return options.writeResult;
      return { output: `ok ${name}`, isError: false };
    },
    async close() {},
  });
  const routes = createChatRoutes({
    keys: localChatKeys(createChatKeyStore(dir, 's'.repeat(40))),
    history: createChatHistoryStore(dir),
    usage: localChatUsage(createChatUsageStore(dir)),
    providers,
    openTools,
    sessionUser: (req) => {
      const login = req.headers['x-test-user'];
      return login === 'alice' ? ALICE : login === 'bob' ? BOB : undefined;
    },
    wikiName: () => 'acme/wiki',
    log: silentLog,
    now: () => new Date('2026-11-14T09:00:00.000Z'),
    ownPort: () => options.ownPort,
  });
  const server: Server = createServer((req, res) => {
    if (!routes.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        routes.stop();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, routes, toolCalls, checkedKeys, opened, ports, server };
}

function call(h: Harness, path: string, init: RequestInit & { user?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.user !== undefined) headers['x-test-user'] = init.user;
  return fetch(`${h.url}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as object) },
  });
}

async function events(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function postOverSocket(
  socketPath: string,
  path: string,
  user: string,
  body: unknown,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': user },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += String(chunk);
        });
        res.on('end', () => resolve(text));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('AI chat routes', () => {
  it('reaches the wiki tools through the server’s own port when the chat came in over a unix socket', async () => {
    const answer = {
      text: 'Done.',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'end' as const,
    };
    const h = await harness({ turns: [answer], ownPort: 4321 });
    await call(h, '/api/gitquire/chat/keys/claude', {
      method: 'PUT',
      user: 'alice',
      body: JSON.stringify({ key: 'sk-ant-key-1234' }),
    });
    const dir = mkdtempSync(join(tmpdir(), 'gq-chat-socket-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const socketServer = await listenOnUnixSocket(h.server, join(dir, 'editor.sock'), createServer);
    cleanups.push(() => new Promise<void>((resolve) => socketServer.close(() => resolve())));
    const text = await postOverSocket(
      join(dir, 'editor.sock'),
      '/api/gitquire/chat/chats/new/messages',
      'alice',
      {
        text: 'Hello',
        provider: 'claude',
      },
    );
    expect(text).toContain('Done.');
    expect(h.ports).toEqual([4321]);
  });

  it('needs a signed-in person', async () => {
    const h = await harness({});
    const response = await call(h, '/api/gitquire/chat');
    expect(response.status).toBe(401);
  });

  it('lists the providers and which keys are saved, without the keys', async () => {
    const h = await harness({});
    const put = await call(h, '/api/gitquire/chat/keys/claude', {
      method: 'PUT',
      user: 'alice',
      body: JSON.stringify({ key: ' sk-ant-api03-abcdef1234 ' }),
    });
    expect(put.status).toBe(200);
    expect(h.checkedKeys).toEqual(['sk-ant-api03-abcdef1234']);

    const overview = await (await call(h, '/api/gitquire/chat', { user: 'alice' })).json();
    const text = JSON.stringify(overview);
    expect(text).not.toContain('sk-ant-api03');
    expect(overview.retentionDays).toBe(90);
    expect(overview.providers.map((p: { id: string }) => p.id)).toEqual(['claude', 'mistral']);
    expect(overview.providers[0].key).toMatchObject({ configured: true, hint: '…1234' });
    expect(overview.providers[1].key).toMatchObject({ configured: false });

    const bobs = await (await call(h, '/api/gitquire/chat', { user: 'bob' })).json();
    expect(bobs.providers[0].key.configured).toBe(false);
  });

  it('refuses a key the provider rejects', async () => {
    const h = await harness({
      checkKey: () => {
        throw new ProviderError('invalid-key', 'invalid x-api-key', 401);
      },
    });
    const put = await call(h, '/api/gitquire/chat/keys/mistral', {
      method: 'PUT',
      user: 'alice',
      body: JSON.stringify({ key: 'wrong-key' }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toMatchObject({ error: 'key-rejected' });
  });

  it('refuses cross-origin changes', async () => {
    const h = await harness({});
    const put = await call(h, '/api/gitquire/chat/keys/claude', {
      method: 'PUT',
      user: 'alice',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ key: 'k' }),
    });
    expect(put.status).toBe(403);
  });

  it('asks for a key before chatting', async () => {
    const h = await harness({});
    const response = await call(h, '/api/gitquire/chat/chats/new/messages', {
      method: 'POST',
      user: 'alice',
      body: JSON.stringify({ text: 'Hi', provider: 'claude' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'no-key' });
  });

  it('streams a chat turn, keeps the chat for its owner and saves it as a page', async () => {
    const h = await harness({
      turns: [
        {
          text: 'Searching.',
          toolCalls: [{ id: 't1', name: 'search', input: { query: 'plan' } }],
          usage: { inputTokens: 100, outputTokens: 10 },
          stopReason: 'tool_use',
        },
        {
          text: 'The plan is in [[notes/plan]].',
          toolCalls: [],
          usage: { inputTokens: 150, outputTokens: 12 },
          stopReason: 'end',
        },
      ],
    });
    await call(h, '/api/gitquire/chat/keys/claude', {
      method: 'PUT',
      user: 'alice',
      body: JSON.stringify({ key: 'sk-ant-key-1234' }),
    });
    const response = await call(h, '/api/gitquire/chat/chats/new/messages', {
      method: 'POST',
      user: 'alice',
      body: JSON.stringify({
        text: 'Where is the plan?',
        provider: 'claude',
        model: 'not-a-model',
        page: 'notes/index',
      }),
    });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const stream = await events(response);
    const first = stream[0] as { type: string; id: string; model: string };
    expect(first).toMatchObject({ type: 'chat', model: 'claude-sonnet-5-5' });
    expect(stream.map((event) => event.type)).toEqual([
      'chat',
      'usage',
      'text',
      'tool',
      'tool-result',
      'usage',
      'text',
      'done',
    ]);
    expect(stream.at(-1)).toEqual({ type: 'done', stopped: 'end' });
    expect(h.toolCalls).toEqual([{ user: 'alice', name: 'search', input: { query: 'plan' } }]);

    const list = await (await call(h, '/api/gitquire/chat/chats', { user: 'alice' })).json();
    expect(list.chats).toHaveLength(1);
    expect(list.chats[0]).toMatchObject({ id: first.id, title: 'Where is the plan?' });
    expect((await call(h, `/api/gitquire/chat/chats/${first.id}`, { user: 'bob' })).status).toBe(
      404,
    );

    const detail = await (
      await call(h, `/api/gitquire/chat/chats/${first.id}`, { user: 'alice' })
    ).json();
    expect(detail.chat.usage).toEqual({ inputTokens: 250, outputTokens: 22 });
    expect(detail.chat.messages[0]).toMatchObject({ role: 'user', page: 'notes/index' });
    expect(detail.suggestedPath).toBe('AI chats/2026-11-14 Where is the plan');

    const saved = await call(h, `/api/gitquire/chat/chats/${first.id}/page`, {
      method: 'POST',
      user: 'alice',
      body: JSON.stringify({ path: 'Meetings/Plan chat' }),
    });
    expect(saved.status).toBe(201);
    const write = h.toolCalls.at(-1);
    expect(write).toMatchObject({ user: 'alice', name: 'write' });
    const document = (write?.input.document ?? {}) as { path: string; content: string };
    expect(document.path).toBe('Meetings/Plan chat');
    expect(document.content).toContain('**@alice:**');
    expect(document.content).toContain('The plan is in [[notes/plan]].');

    const removed = await call(h, `/api/gitquire/chat/chats/${first.id}`, {
      method: 'DELETE',
      user: 'alice',
    });
    expect(removed.status).toBe(200);
    expect(
      (await (await call(h, '/api/gitquire/chat/chats', { user: 'alice' })).json()).chats,
    ).toEqual([]);

    const usage = await (await call(h, '/api/gitquire/chat/usage', { user: 'alice' })).json();
    expect(usage).toEqual({
      retentionDays: 90,
      total: { inputTokens: 250, outputTokens: 22 },
      days: [{ day: '2026-11-14', inputTokens: 250, outputTokens: 22 }],
      chats: [
        {
          chatId: first.id,
          title: 'Where is the plan?',
          provider: 'claude',
          model: 'claude-sonnet-5-5',
          lastDay: '2026-11-14',
          inputTokens: 250,
          outputTokens: 22,
        },
      ],
    });
    const bobs = await (await call(h, '/api/gitquire/chat/usage', { user: 'bob' })).json();
    expect(bobs.total).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect((await call(h, '/api/gitquire/chat/usage', {})).status).toBe(401);
  });

  it('sends the edits of a chat where the person chose, and keeps that choice for the chat', async () => {
    const answer = {
      text: 'Done.',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'end' as const,
    };
    const h = await harness({ turns: [answer, answer, answer] });
    await call(h, '/api/gitquire/chat/keys/claude', {
      method: 'PUT',
      user: 'alice',
      body: JSON.stringify({ key: 'sk-ant-key-1234' }),
    });
    const first = await events(
      await call(h, '/api/gitquire/chat/chats/new/messages', {
        method: 'POST',
        user: 'alice',
        body: JSON.stringify({ text: 'Fix the typo', provider: 'claude', edits: 'draft' }),
      }),
    );
    const id = (first[0] as { id: string }).id;
    await events(
      await call(h, `/api/gitquire/chat/chats/${id}/messages`, {
        method: 'POST',
        user: 'alice',
        body: JSON.stringify({ text: 'And the title', provider: 'claude' }),
      }),
    );
    expect(h.opened).toEqual(['draft', 'draft']);
    const saved = await (await call(h, `/api/gitquire/chat/chats/${id}`, { user: 'alice' })).json();
    expect(saved.chat.edits).toBe('draft');

    await events(
      await call(h, `/api/gitquire/chat/chats/${id}/messages`, {
        method: 'POST',
        user: 'alice',
        body: JSON.stringify({ text: 'Now live', provider: 'claude', edits: 'live' }),
      }),
    );
    expect(h.opened.at(-1)).toBe('live');

    const bad = await call(h, `/api/gitquire/chat/chats/${id}/messages`, {
      method: 'POST',
      user: 'alice',
      body: JSON.stringify({ text: 'x', provider: 'claude', edits: 'somewhere' }),
    });
    expect(bad.status).toBe(400);
  });

  it('streams provider errors so the person sees what to do', async () => {
    const h = await harness({ turns: [] });
    await call(h, '/api/gitquire/chat/keys/claude', {
      method: 'PUT',
      user: 'alice',
      body: JSON.stringify({ key: 'sk-ant-key-1234' }),
    });
    const stream = await events(
      await call(h, '/api/gitquire/chat/chats/new/messages', {
        method: 'POST',
        user: 'alice',
        body: JSON.stringify({ text: 'Hi', provider: 'claude' }),
      }),
    );
    expect(stream).toContainEqual({ type: 'error', code: 'overloaded', message: 'Overloaded.' });
    expect(stream.at(-1)).toEqual({ type: 'done', stopped: 'error' });
  });

  it('does not overwrite an existing page when saving', async () => {
    const h = await harness({
      turns: [
        {
          text: 'Hello',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end',
        },
      ],
      writeResult: {
        output: 'Document "x" already exists; pass position: replace, append or prepend.',
        isError: true,
      },
    });
    await call(h, '/api/gitquire/chat/keys/claude', {
      method: 'PUT',
      user: 'alice',
      body: JSON.stringify({ key: 'sk-ant-key-1234' }),
    });
    const stream = await events(
      await call(h, '/api/gitquire/chat/chats/new/messages', {
        method: 'POST',
        user: 'alice',
        body: JSON.stringify({ text: 'Hi', provider: 'claude' }),
      }),
    );
    const id = (stream[0] as { id: string }).id;
    const saved = await call(h, `/api/gitquire/chat/chats/${id}/page`, {
      method: 'POST',
      user: 'alice',
      body: JSON.stringify({ path: 'x' }),
    });
    expect(saved.status).toBe(409);
    const invalid = await call(h, `/api/gitquire/chat/chats/${id}/page`, {
      method: 'POST',
      user: 'alice',
      body: JSON.stringify({ path: '../x' }),
    });
    expect(invalid.status).toBe(400);
  });
});
