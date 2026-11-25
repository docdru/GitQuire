import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GateLogger } from '../access-gate.ts';
import { sendJson } from '../http-util.ts';
import { type EmailPerson, EmailRequestError, type EmailService } from './email-service.ts';

const MAX_BODY_BYTES = 16 * 1024;

export const EMAIL_PATH = '/api/gitquire/mentions/email';
export const EMAIL_CONFIRM_PATH = '/api/gitquire/mentions/email/confirm';

export interface PersonRoute {
  matches: (path: string, method: string) => boolean;
  answer: (
    req: IncomingMessage,
    who: EmailPerson,
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
}

export interface PersonRoutes {
  handles: (path: string, method: string) => boolean;
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    who: EmailPerson | undefined,
    path: string,
  ) => void;
}

export class PersonRouteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES)
      throw new PersonRouteError(413, 'too-large', 'The request is too large.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new PersonRouteError(400, 'invalid-json', 'Send JSON.');
  }
}

export function emailRoutes(email: EmailService): PersonRoute {
  return {
    matches: (path, method) =>
      (path === EMAIL_PATH && (method === 'GET' || method === 'PUT')) ||
      (path === EMAIL_CONFIRM_PATH && method === 'POST'),
    answer: (_req, who, path, method, body) => {
      if (path === EMAIL_PATH && method === 'GET') {
        email.seen(who);
        return email.state(who.person);
      }
      if (path === EMAIL_PATH) return email.change(who, body);
      return email.confirm(who, body);
    },
  };
}

export function createPersonRoutes(options: {
  routes: readonly PersonRoute[];
  sameOrigin: (req: IncomingMessage) => boolean;
  log: Pick<GateLogger, 'error'>;
}): PersonRoutes {
  const find = (path: string, method: string) =>
    options.routes.find((route) => route.matches(path, method));
  return {
    handles: (path, method) => find(path, method) !== undefined,
    handle: (req, res, who, path) => {
      const method = req.method ?? 'GET';
      const route = find(path, method);
      if (route === undefined) {
        sendJson(res, 404, { error: 'not-found', message: 'Unknown GitQuire endpoint.' });
        return;
      }
      if (who === undefined) {
        sendJson(res, 401, { error: 'sign-in-required', message: 'Sign in first.' });
        return;
      }
      if (method !== 'GET' && !options.sameOrigin(req)) {
        sendJson(res, 403, {
          error: 'cross-origin',
          message: 'Cross-origin requests are not allowed.',
        });
        return;
      }
      (method === 'GET' ? Promise.resolve({}) : readBody(req))
        .then((body) => route.answer(req, who, path, method, body))
        .then(
          (value) => sendJson(res, 200, value),
          (err: unknown) => {
            if (err instanceof EmailRequestError || err instanceof PersonRouteError) {
              sendJson(res, err.status, { error: err.code, message: err.message });
              return;
            }
            options.log.error({ err, path }, '[gitquire-people] route failed');
            if (!res.headersSent)
              sendJson(res, 500, { error: 'internal', message: 'Internal error.' });
          },
        );
    },
  };
}
