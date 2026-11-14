import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import { type ChatEvent, runChatTurn, systemPrompt } from './agent.ts';
import {
  CHAT_RETENTION_DAYS,
  type ChatHistoryStore,
  type ChatRecord,
  isChatId,
  newChatId,
  titleFrom,
} from './history.ts';
import { type ChatKeyStore, InvalidApiKeyError, normalizeApiKey } from './key-store.ts';
import {
  CHAT_PROVIDERS,
  type ChatProvider,
  isChatProvider,
  PROVIDER_INFO,
  resolveModel,
} from './models.ts';
import { type ChatProviders, ProviderError } from './providers.ts';
import {
  chatTranscript,
  InvalidPagePathError,
  normalizePagePath,
  suggestedPagePath,
} from './transcript.ts';
import type { OpenWikiTools } from './wiki-tools.ts';

export const MAX_MESSAGE_CHARS = 20_000;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_PAGE_CHARS = 300;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

class ChatHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ChatHttpError(413, 'body-too-large', 'Message too long.');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  throw new ChatHttpError(400, 'invalid-json', 'Body must be a JSON object.');
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  try {
    return new URL(origin).host === (Array.isArray(host) ? host[0] : host);
  } catch {
    return false;
  }
}

export interface ChatRoutesDeps {
  keys: ChatKeyStore;
  history: ChatHistoryStore;
  providers: ChatProviders;
  openTools: OpenWikiTools;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  wikiName: () => string;
  log: GateLogger;
  now?: () => Date;
}

export interface ChatRoutes {
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  stop(): void;
}

export const CHAT_API_PREFIX = '/api/gitquire/chat';

export function createChatRoutes(deps: ChatRoutesDeps): ChatRoutes {
  const now = deps.now ?? (() => new Date());
  const running = new Set<number>();
  const purge = () => {
    try {
      const removed = deps.history.purgeExpired(now());
      if (removed > 0) deps.log.info({ removed }, '[gitquire-chat] removed expired chats');
    } catch (err) {
      deps.log.warn({ err }, '[gitquire-chat] could not remove expired chats');
    }
  };
  purge();
  const purgeTimer = setInterval(purge, PURGE_INTERVAL_MS);
  purgeTimer.unref?.();

  function requireUser(req: IncomingMessage): SessionUser {
    const user = deps.sessionUser(req);
    if (user === undefined) {
      throw new ChatHttpError(401, 'sign-in-required', 'Sign in to use the AI chat.');
    }
    return user;
  }

  function providerFrom(value: unknown): ChatProvider {
    if (!isChatProvider(value)) {
      throw new ChatHttpError(400, 'invalid-provider', `Choose ${CHAT_PROVIDERS.join(' or ')}.`);
    }
    return value;
  }

  function overview(user: SessionUser) {
    const keys = deps.keys.info(user.id);
    return {
      available: true,
      retentionDays: CHAT_RETENTION_DAYS,
      providers: CHAT_PROVIDERS.map((id) => ({
        id,
        label: PROVIDER_INFO[id].label,
        models: PROVIDER_INFO[id].models,
        defaultModel: PROVIDER_INFO[id].defaultModel,
        keyUrl: PROVIDER_INFO[id].keyUrl,
        limitsUrl: PROVIDER_INFO[id].limitsUrl,
        key: keys[id],
      })),
    };
  }

  async function saveKey(req: IncomingMessage, res: ServerResponse, provider: ChatProvider) {
    const user = requireUser(req);
    const body = await readJson(req);
    let key: string;
    try {
      key = normalizeApiKey(body.key);
    } catch (err) {
      if (err instanceof InvalidApiKeyError)
        throw new ChatHttpError(400, 'invalid-key', err.message);
      throw err;
    }
    try {
      await deps.providers.checkKey(provider, key);
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.code === 'invalid-key') {
          throw new ChatHttpError(
            400,
            'key-rejected',
            `${PROVIDER_INFO[provider].label} did not accept this key.`,
          );
        }
        if (err.code !== 'rate-limited' && err.code !== 'no-credit' && err.code !== 'spend-limit') {
          throw new ChatHttpError(
            502,
            'key-check-failed',
            `The key could not be checked: ${err.message}`,
          );
        }
      } else {
        throw err;
      }
    }
    const info = deps.keys.set(user.id, provider, key, now());
    deps.log.info({ login: user.login, provider }, '[gitquire-chat] saved an API key');
    sendJson(res, 200, { provider, key: info });
  }

  function newChat(provider: ChatProvider, model: string, text: string): ChatRecord {
    const at = now().toISOString();
    return {
      id: newChatId(),
      title: titleFrom(text),
      provider,
      model,
      createdAt: at,
      updatedAt: at,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async function postMessage(req: IncomingMessage, res: ServerResponse, chatId: string) {
    const user = requireUser(req);
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text === '') throw new ChatHttpError(400, 'empty-message', 'Write a message first.');
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new ChatHttpError(400, 'message-too-long', 'That message is too long.');
    }
    const page =
      typeof body.page === 'string' && body.page.trim() !== '' && body.page.length <= MAX_PAGE_CHARS
        ? body.page.trim()
        : undefined;
    const provider = providerFrom(body.provider);
    const model = resolveModel(provider, body.model);
    const apiKey = deps.keys.get(user.id, provider);
    if (apiKey === undefined) {
      throw new ChatHttpError(
        409,
        'no-key',
        `Add your ${PROVIDER_INFO[provider].label} API key in Settings → AI chat first.`,
      );
    }
    let chat: ChatRecord;
    if (chatId === 'new') {
      chat = newChat(provider, model, text);
    } else {
      const existing = deps.history.get(user.id, chatId);
      if (existing === undefined) throw new ChatHttpError(404, 'chat-not-found', 'Chat not found.');
      chat = existing;
      chat.provider = provider;
      chat.model = model;
    }
    if (running.has(user.id)) {
      throw new ChatHttpError(409, 'busy', 'Wait for the current answer, or stop it first.');
    }
    const port = req.socket.localPort;
    if (port === undefined) throw new ChatHttpError(503, 'tools-unavailable', 'Try again.');

    running.add(user.id);
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', onClose);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    const emit = (event: ChatEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      chat.messages.push({
        role: 'user',
        text,
        ...(page ? { page } : {}),
        at: now().toISOString(),
      });
      chat.updatedAt = now().toISOString();
      deps.history.save(user.id, chat);
      emit({ type: 'chat', id: chat.id, title: chat.title, provider, model });
      let tools: Awaited<ReturnType<OpenWikiTools>>;
      try {
        tools = await deps.openTools(user, port, controller.signal);
      } catch (err) {
        deps.log.warn({ err }, '[gitquire-chat] could not open the wiki tools');
        emit({
          type: 'error',
          code: 'tools-unavailable',
          message: 'The wiki tools could not be started. Try again in a moment.',
        });
        emit({ type: 'done', stopped: 'error' });
        return;
      }
      try {
        const done = await runChatTurn({
          chat,
          apiKey,
          providers: deps.providers,
          tools,
          system: systemPrompt({
            user,
            wikiName: deps.wikiName(),
            today: now().toISOString().slice(0, 10),
          }),
          emit,
          persist: (record) => deps.history.save(user.id, record),
          now,
          signal: controller.signal,
        });
        deps.log.info(
          {
            login: user.login,
            provider,
            model,
            stopped: done.stopped,
            inputTokens: chat.usage.inputTokens,
            outputTokens: chat.usage.outputTokens,
          },
          '[gitquire-chat] answered',
        );
      } finally {
        await tools.close().catch(() => undefined);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        deps.log.error({ err }, '[gitquire-chat] chat turn failed');
        emit({ type: 'error', code: 'unexpected', message: 'Something went wrong. Try again.' });
        emit({ type: 'done', stopped: 'error' });
      }
    } finally {
      running.delete(user.id);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  }

  async function saveAsPage(req: IncomingMessage, res: ServerResponse, chatId: string) {
    const user = requireUser(req);
    const chat = deps.history.get(user.id, chatId);
    if (chat === undefined) throw new ChatHttpError(404, 'chat-not-found', 'Chat not found.');
    const body = await readJson(req);
    let path: string;
    try {
      path = normalizePagePath(body.path ?? suggestedPagePath(chat));
    } catch (err) {
      if (err instanceof InvalidPagePathError) {
        throw new ChatHttpError(400, 'invalid-path', err.message);
      }
      throw err;
    }
    const port = req.socket.localPort;
    if (port === undefined) throw new ChatHttpError(503, 'tools-unavailable', 'Try again.');
    const tools = await deps.openTools(user, port);
    try {
      const written = await tools.call('write', {
        document: { path, content: chatTranscript(chat, user) },
        summary: 'Saved an AI chat as a page',
      });
      if (written.isError) {
        if (/already exists/i.test(written.output)) {
          throw new ChatHttpError(409, 'page-exists', 'A page with that name already exists.');
        }
        throw new ChatHttpError(422, 'save-failed', written.output.slice(0, 300));
      }
    } finally {
      await tools.close().catch(() => undefined);
    }
    deps.log.info({ login: user.login, path }, '[gitquire-chat] saved a chat as a page');
    sendJson(res, 201, { path });
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
      throw new ChatHttpError(403, 'cross-origin', 'Cross-origin requests are not allowed.');
    }
    if (path === CHAT_API_PREFIX && method === 'GET') {
      sendJson(res, 200, overview(requireUser(req)));
      return;
    }
    const keyMatch = /^\/api\/gitquire\/chat\/keys\/([a-z]+)$/.exec(path);
    if (keyMatch !== null) {
      const provider = providerFrom(keyMatch[1]);
      if (method === 'PUT') return saveKey(req, res, provider);
      if (method === 'DELETE') {
        const user = requireUser(req);
        deps.keys.remove(user.id, provider);
        deps.log.info({ login: user.login, provider }, '[gitquire-chat] removed an API key');
        sendJson(res, 200, { provider, key: deps.keys.info(user.id)[provider] });
        return;
      }
    }
    if (path === `${CHAT_API_PREFIX}/chats` && method === 'GET') {
      sendJson(res, 200, { chats: deps.history.list(requireUser(req).id) });
      return;
    }
    const chatMatch = /^\/api\/gitquire\/chat\/chats\/([A-Za-z0-9_-]+)(\/messages|\/page)?$/.exec(
      path,
    );
    if (chatMatch !== null) {
      const id = chatMatch[1] as string;
      const action = chatMatch[2];
      if (action === '/messages' && method === 'POST') {
        if (id !== 'new' && !isChatId(id))
          throw new ChatHttpError(404, 'chat-not-found', 'Chat not found.');
        return postMessage(req, res, id);
      }
      if (!isChatId(id)) throw new ChatHttpError(404, 'chat-not-found', 'Chat not found.');
      if (action === '/page' && method === 'POST') return saveAsPage(req, res, id);
      if (action === undefined && method === 'GET') {
        const user = requireUser(req);
        const chat = deps.history.get(user.id, id);
        if (chat === undefined) throw new ChatHttpError(404, 'chat-not-found', 'Chat not found.');
        sendJson(res, 200, { chat, suggestedPath: suggestedPagePath(chat) });
        return;
      }
      if (action === undefined && method === 'DELETE') {
        const user = requireUser(req);
        if (!deps.history.remove(user.id, id)) {
          throw new ChatHttpError(404, 'chat-not-found', 'Chat not found.');
        }
        sendJson(res, 200, { deleted: id });
        return;
      }
    }
    throw new ChatHttpError(404, 'not-found', 'Unknown AI chat endpoint.');
  }

  return {
    handle(req, res) {
      const path = new URL(req.url ?? '/', 'http://gitquire.invalid').pathname;
      if (path !== CHAT_API_PREFIX && !path.startsWith(`${CHAT_API_PREFIX}/`)) return false;
      route(req, res, path).catch((err: unknown) => {
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (err instanceof ChatHttpError) {
          sendJson(res, err.status, { error: err.code, message: err.message });
        } else {
          deps.log.error({ err, path }, '[gitquire-chat] request failed');
          sendJson(res, 500, { error: 'internal', message: 'Internal error.' });
        }
      });
      return true;
    },
    stop() {
      clearInterval(purgeTimer);
    },
  };
}
