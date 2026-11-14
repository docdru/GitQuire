import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { GateLogger, SessionUser } from '../access-gate.ts';
import { encodeProxiedUser, PROXIED_PRINCIPAL_HEADER } from '../access-gate.ts';
import { pathOf, redirect, sendJson } from '../http-util.ts';
import { internalRequestHeaders } from '../internal-request.ts';
import { isSameOrigin } from '../routes.ts';
import type { DraftInstances } from './instances.ts';
import {
  cleanTitle,
  type DraftRecord,
  isOpen,
  isSlug,
  readCookie,
  servedByLive,
  VIEW_COOKIE,
  viewCookie,
} from './model.ts';
import { proxyRequest, proxyUpgrade } from './proxy.ts';
import { DraftError, type DraftService } from './service.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_NOTE = 2000;
const MAX_LOGINS = 20;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MCP_SESSION_HEADER = 'mcp-session-id';
const MAX_STICKY = 500;

export interface DraftsHttpDeps {
  service: DraftService;
  instances: DraftInstances;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  agentOwner: (req: IncomingMessage) => SessionUser | undefined;
  secure: boolean;
  log: GateLogger;
}

export interface DraftsHttp {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => boolean;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
}

function wantsPage(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return (req.headers.accept ?? '').includes('text/html');
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new DraftError(413, 'body-too-large', 'Request too large.');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new DraftError(400, 'invalid-json', 'Body must be a JSON object.');
  }
  throw new DraftError(400, 'invalid-json', 'Body must be a JSON object.');
}

function note(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_NOTE) {
    throw new DraftError(400, 'invalid-note', 'The note is too long.');
  }
  return value;
}

function logins(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LOGINS) {
    throw new DraftError(400, 'invalid-people', 'Choose up to 20 people.');
  }
  return value.map((entry) => {
    const login = typeof entry === 'string' ? entry.replace(/^@/, '').trim() : '';
    if (!LOGIN_RE.test(login))
      throw new DraftError(400, 'invalid-people', `"${String(entry)}" is not a GitHub login.`);
    return login;
  });
}

function resolutions(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DraftError(400, 'invalid-resolution', 'Send the resolved pages as an object.');
  }
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(value)) {
    if (typeof content !== 'string') {
      throw new DraftError(400, 'invalid-resolution', `The resolution for ${path} must be text.`);
    }
    out[path] = content;
  }
  return out;
}

export function createDraftsHttp(deps: DraftsHttpDeps): DraftsHttp {
  const { service, instances } = deps;
  const lastView = new Map<number, string | null>();
  const sticky = new Map<string, string>();

  function viewOf(req: IncomingMessage): string | undefined {
    const value = readCookie(req.headers.cookie, VIEW_COOKIE);
    return isSlug(value) ? value : undefined;
  }

  function openDraft(slug: string | undefined): DraftRecord | undefined {
    if (slug === undefined) return undefined;
    const draft = service.get(slug);
    return draft !== undefined && isOpen(draft) ? draft : undefined;
  }

  function requireUser(req: IncomingMessage): SessionUser {
    const user = deps.sessionUser(req);
    if (user === undefined) throw new DraftError(401, 'sign-in-required', 'Sign in to use drafts.');
    return user;
  }

  function cookieFor(slug: string | null): string {
    return viewCookie(slug, deps.secure);
  }

  function rememberView(req: IncomingMessage, slug: string | null): void {
    const user = deps.sessionUser(req);
    if (user !== undefined) lastView.set(user.id, slug);
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && !isSameOrigin(req)) {
      throw new DraftError(403, 'cross-origin', 'Cross-origin requests are not allowed.');
    }
    const user = requireUser(req);
    const viewing = viewOf(req);
    lastView.set(user.id, openDraft(viewing)?.slug ?? null);

    if (path === '/api/gitquire/drafts' && method === 'GET') {
      sendJson(res, 200, {
        enabled: true,
        me: user.login,
        viewing: openDraft(viewing)?.slug ?? null,
        drafts: service.list(),
      });
      return;
    }
    if (path === '/api/gitquire/drafts' && method === 'POST') {
      const body = await readBody(req);
      const title = cleanTitle(body.title);
      if (title === undefined)
        throw new DraftError(
          400,
          'invalid-title',
          'Give the draft a name of up to 120 characters.',
        );
      const draft = await service.create(user, title);
      const open = body.open !== false;
      if (open) lastView.set(user.id, draft.slug);
      sendJson(
        res,
        201,
        { draft: service.summary(draft) },
        open ? { 'Set-Cookie': cookieFor(draft.slug) } : {},
      );
      return;
    }
    if (path === '/api/gitquire/drafts/move' && method === 'POST') {
      const body = await readBody(req);
      const title = cleanTitle(body.title);
      if (title === undefined)
        throw new DraftError(
          400,
          'invalid-title',
          'Give the draft a name of up to 120 characters.',
        );
      if (typeof body.path !== 'string')
        throw new DraftError(400, 'invalid-path', 'Choose a page.');
      const draft = await service.moveRecentEdits(user, body.path, title);
      lastView.set(user.id, draft.slug);
      sendJson(
        res,
        201,
        { draft: service.summary(draft) },
        { 'Set-Cookie': cookieFor(draft.slug) },
      );
      return;
    }
    if (path === '/api/gitquire/drafts/current' && method === 'GET') {
      const draft = openDraft(viewing);
      if (draft === undefined && viewing !== undefined) {
        const gone = service.get(viewing);
        sendJson(res, 200, {
          viewing: null,
          drift: null,
          closed: {
            slug: viewing,
            title: gone?.title ?? viewing,
            status: gone?.status ?? 'discarded',
            closedBy: gone?.closedBy ?? null,
          },
        });
        return;
      }
      sendJson(res, 200, {
        viewing: draft === undefined ? null : service.summary(draft),
        drift: draft === undefined ? null : service.drift(draft.slug),
        closed: null,
      });
      return;
    }
    if (path === '/api/gitquire/drafts/agent-mode') {
      if (method === 'PUT') {
        const body = await readBody(req);
        if (body.mode !== 'live' && body.mode !== 'draft') {
          throw new DraftError(400, 'invalid-mode', 'Choose "live" or "draft".');
        }
        service.setAgentMode(user.id, body.mode);
      }
      sendJson(res, 200, { mode: service.agentMode(user.id) });
      return;
    }
    if (path === '/api/gitquire/view' && method === 'POST') {
      const body = await readBody(req);
      const wanted = body.slug === null ? null : isSlug(body.slug) ? body.slug : undefined;
      if (wanted === undefined) throw new DraftError(400, 'invalid-draft', 'Choose a draft.');
      if (wanted !== null) service.requireOpen(wanted);
      lastView.set(user.id, wanted);
      sendJson(res, 200, { viewing: wanted }, { 'Set-Cookie': cookieFor(wanted) });
      return;
    }

    const match = /^\/api\/gitquire\/drafts\/([a-z0-9-]+)\/([a-z]+)$/.exec(path);
    if (match === null) throw new DraftError(404, 'not-found', 'Unknown drafts request.');
    const slug = match[1] as string;
    const action = match[2] as string;

    if (action === 'changes' && method === 'GET') {
      sendJson(res, 200, { pages: service.changes(slug) });
      return;
    }
    if (method !== 'POST') throw new DraftError(405, 'method-not-allowed', 'Use POST.');
    const body = await readBody(req);
    const leave: Record<string, string> = viewing === slug ? { 'Set-Cookie': cookieFor(null) } : {};
    switch (action) {
      case 'rename': {
        const title = cleanTitle(body.title);
        if (title === undefined)
          throw new DraftError(
            400,
            'invalid-title',
            'Give the draft a name of up to 120 characters.',
          );
        sendJson(res, 200, { draft: service.summary(service.rename(slug, title)) });
        return;
      }
      case 'ready': {
        const draft = await service.markReady(slug, user, logins(body.logins), note(body.note));
        sendJson(res, 200, { draft: service.summary(draft) });
        return;
      }
      case 'unready':
        sendJson(res, 200, { draft: service.summary(service.markDraft(slug)) });
        return;
      case 'review': {
        if (body.verdict !== 'approved' && body.verdict !== 'changes') {
          throw new DraftError(400, 'invalid-verdict', 'Choose "approved" or "changes".');
        }
        const draft = service.review(slug, user, body.verdict, note(body.note));
        sendJson(res, 200, { draft: service.summary(draft) });
        return;
      }
      case 'publish': {
        const draft = await service.publish(slug, user);
        if (viewing === slug) lastView.set(user.id, null);
        sendJson(res, 200, { draft: service.summary(draft) }, leave);
        return;
      }
      case 'discard': {
        const draft = await service.discard(slug, user);
        if (viewing === slug) lastView.set(user.id, null);
        sendJson(res, 200, { draft: service.summary(draft) }, leave);
        return;
      }
      case 'update': {
        const result = await service.update(slug, user, resolutions(body.resolved));
        sendJson(res, 200, result);
        return;
      }
      default:
        throw new DraftError(404, 'not-found', 'Unknown drafts request.');
    }
  }

  function fail(res: ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof DraftError) {
      sendJson(res, err.status, { error: err.code, message: err.message });
      return;
    }
    deps.log.error({ err }, '[gitquire-drafts] request failed');
    const message = err instanceof Error ? err.message.split('\n')[0] : 'Something went wrong.';
    sendJson(res, 500, { error: 'draft-failed', message });
  }

  function unreachable(req: IncomingMessage, res: ServerResponse, err: unknown): void {
    deps.log.error({ err }, '[gitquire-drafts] could not open a draft');
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const message = err instanceof Error ? err.message : 'The draft could not be opened.';
    if ((req.headers.accept ?? '').includes('text/html')) {
      res.writeHead(503, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': cookieFor(null),
      });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Draft unavailable</title><p>${message.replace(/[<&]/g, '')}</p><p><a href="/">Back to the live wiki</a></p>`,
      );
      return;
    }
    sendJson(res, 503, { error: 'draft-unavailable', message });
  }

  function routeAgent(req: IncomingMessage, res: ServerResponse): boolean {
    const owner = deps.agentOwner(req);
    if (owner === undefined || service.agentMode(owner.id) !== 'draft') return false;
    const session = req.headers[MCP_SESSION_HEADER];
    const stuck = typeof session === 'string' ? openDraft(sticky.get(session)) : undefined;
    const viewed = openDraft(lastView.get(owner.id) ?? undefined);
    const target: Promise<DraftRecord> =
      stuck !== undefined
        ? Promise.resolve(stuck)
        : viewed !== undefined
          ? Promise.resolve(viewed)
          : service.agentDraft(owner);
    target
      .then(async (draft) => {
        const port = await instances.ensure(draft);
        instances.touch(draft.slug);
        proxyRequest(req, res, port, {
          extraHeaders: {
            ...internalRequestHeaders(),
            [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser(owner),
          },
          onResponse: (_status, headers) => {
            const id = headers[MCP_SESSION_HEADER];
            if (typeof id === 'string') {
              if (sticky.size >= MAX_STICKY) {
                const oldest = sticky.keys().next().value;
                if (oldest !== undefined) sticky.delete(oldest);
              }
              sticky.set(id, draft.slug);
            }
            return undefined;
          },
        });
      })
      .catch((err: unknown) => unreachable(req, res, err));
    return true;
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const { path } = pathOf(req);
    if (path === '/mcp' || path.startsWith('/mcp/')) return routeAgent(req, res);
    if (path.startsWith('/api/gitquire/drafts') || path === '/api/gitquire/view') {
      api(req, res, path).catch((err: unknown) => fail(res, err));
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://gitquire.invalid');
    const wanted = url.searchParams.get('draft');
    if (
      wanted !== null &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !path.startsWith('/api/')
    ) {
      url.searchParams.delete('draft');
      const target = openDraft(isSlug(wanted) ? wanted : undefined)?.slug ?? null;
      rememberView(req, target);
      redirect(res, `${url.pathname}${url.search}`, { 'Set-Cookie': cookieFor(target) });
      return true;
    }
    if (servedByLive(path)) return false;
    const slug = viewOf(req);
    if (slug === undefined) return false;
    const draft = openDraft(slug);
    if (draft === undefined) {
      if (wantsPage(req)) {
        redirect(res, req.url ?? '/', { 'Set-Cookie': cookieFor(null) });
        return true;
      }
      sendJson(res, 409, {
        error: 'draft-closed',
        message: 'This draft was published or discarded. Reload to go back to the live wiki.',
      });
      return true;
    }
    instances
      .ensure(draft)
      .then((port) => {
        instances.touch(draft.slug);
        proxyRequest(req, res, port);
      })
      .catch((err: unknown) => unreachable(req, res, err));
    return true;
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const { path } = pathOf(req);
    if (servedByLive(path)) return false;
    const slug = viewOf(req);
    if (slug === undefined) return false;
    const draft = openDraft(slug);
    if (draft === undefined) {
      socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return true;
    }
    instances
      .ensure(draft)
      .then((port) => {
        const release = instances.hold(draft.slug);
        proxyUpgrade(req, socket, head, port, release);
      })
      .catch((err: unknown) => {
        deps.log.error({ err }, '[gitquire-drafts] could not open a draft for live editing');
        socket.destroy();
      });
    return true;
  }

  return { handleRequest, handleUpgrade };
}
