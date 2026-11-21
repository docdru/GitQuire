import { type IncomingMessage, request, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { INTERNAL_REQUEST_HEADER } from '../internal-request.ts';
import {
  FORWARDED_PREFIX_HEADER,
  FORWARDED_VIEW_HEADER,
  PROXIED_PRINCIPAL_HEADER,
} from '../request-person.ts';

const INTERNAL_ONLY = new Set([
  INTERNAL_REQUEST_HEADER,
  PROXIED_PRINCIPAL_HEADER,
  FORWARDED_PREFIX_HEADER,
  FORWARDED_VIEW_HEADER,
]);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardedHeaders(
  req: IncomingMessage,
  extra: Record<string, string> = {},
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (INTERNAL_ONLY.has(lower)) continue;
    headers[lower] = value;
  }
  return { ...headers, ...extra };
}

const UNSAFE_HEADER_TEXT = /[\r\n\0]/;

export function hasUnsafeHeader(headers: Record<string, string | string[]>): boolean {
  return Object.entries(headers).some(
    ([name, value]) =>
      UNSAFE_HEADER_TEXT.test(name) ||
      (Array.isArray(value) ? value : [value]).some((item) => UNSAFE_HEADER_TEXT.test(item)),
  );
}

export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  socketPath: string,
  options: {
    extraHeaders?: Record<string, string>;
    onResponse?: (
      status: number,
      headers: IncomingMessage['headers'],
    ) => Record<string, string | string[]> | undefined;
    unavailable?: { error: string; message: string };
    rewriteHeaders?: (
      headers: Record<string, string | string[]>,
    ) => Record<string, string | string[]>;
  } = {},
): void {
  const sent = forwardedHeaders(req, options.extraHeaders);
  if (hasUnsafeHeader(sent)) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'bad-header' }));
    return;
  }
  const upstream = request(
    {
      socketPath,
      method: req.method,
      path: req.url,
      headers: sent,
    },
    (answer) => {
      const status = answer.statusCode ?? 502;
      const added = options.onResponse?.(status, answer.headers) ?? {};
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
        headers[name] = value;
      }
      for (const [name, value] of Object.entries(added)) {
        const existing = headers[name];
        if (name.toLowerCase() === 'set-cookie' && existing !== undefined) {
          headers[name] = [
            ...(Array.isArray(existing) ? existing : [existing]),
            ...(Array.isArray(value) ? value : [value]),
          ];
        } else {
          headers[name] = value;
        }
      }
      res.writeHead(status, options.rewriteHeaders?.(headers) ?? headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify(
          options.unavailable ?? {
            error: 'draft-unavailable',
            message: 'The draft is not reachable.',
          },
        ),
      );
    } else {
      res.destroy();
    }
  });
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

function headerLines(headers: Record<string, string | string[]>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  return lines.join('\r\n');
}

export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  socketPath: string,
  onClose: () => void,
  extraHeaders: Record<string, string> = {},
): void {
  const headers = forwardedHeaders(req, {
    ...extraHeaders,
    connection: 'Upgrade',
    upgrade: String(req.headers.upgrade ?? 'websocket'),
  });
  if (hasUnsafeHeader(headers) || UNSAFE_HEADER_TEXT.test(`${req.method ?? ''}${req.url ?? ''}`)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    onClose();
    return;
  }
  const upstream = connect(socketPath);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    upstream.destroy();
    socket.destroy();
    onClose();
  };
  upstream.on('connect', () => {
    upstream.write(
      `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n${headerLines(headers)}\r\n\r\n`,
    );
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', close);
  upstream.on('close', close);
  upstream.on('end', close);
  socket.on('error', close);
  socket.on('close', close);
  socket.on('end', close);
}
