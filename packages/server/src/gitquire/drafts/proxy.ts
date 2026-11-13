import { type IncomingMessage, request, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { PROXIED_PRINCIPAL_HEADER } from '../access-gate.ts';
import { INTERNAL_REQUEST_HEADER } from '../internal-request.ts';

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

export function forwardedHeaders(
  req: IncomingMessage,
  extra: Record<string, string> = {},
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === INTERNAL_REQUEST_HEADER || lower === PROXIED_PRINCIPAL_HEADER) continue;
    headers[lower] = value;
  }
  return { ...headers, ...extra };
}

export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  options: {
    extraHeaders?: Record<string, string>;
    onResponse?: (
      status: number,
      headers: IncomingMessage['headers'],
    ) => Record<string, string | string[]> | undefined;
  } = {},
): void {
  const upstream = request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, options.extraHeaders),
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
      res.writeHead(status, headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({ error: 'draft-unavailable', message: 'The draft is not reachable.' }),
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
  port: number,
  onClose: () => void,
): void {
  const upstream = connect(port, '127.0.0.1');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    upstream.destroy();
    socket.destroy();
    onClose();
  };
  upstream.on('connect', () => {
    const headers = forwardedHeaders(req, {
      connection: 'Upgrade',
      upgrade: String(req.headers.upgrade ?? 'websocket'),
    });
    upstream.write(
      `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n${headerLines(headers)}\r\n\r\n`,
    );
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', close);
  upstream.on('close', close);
  socket.on('error', close);
  socket.on('close', close);
}
