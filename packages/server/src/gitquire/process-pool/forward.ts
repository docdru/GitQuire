import { type IncomingMessage, request, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { type Duplex, pipeline } from 'node:stream';
import { createGzip, constants as zlibConstants } from 'node:zlib';
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

const COMPRESSIBLE =
  /^(application\/(json|javascript|manifest\+json|xml|problem\+json)|text\/(html|css|javascript|plain|markdown|xml)|image\/svg\+xml)\b/i;
const MIN_COMPRESS_BYTES = 1024;

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

export function acceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  for (const part of headerText(acceptEncoding).split(',')) {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q === undefined || Number(q.slice(2)) > 0) return true;
  }
  return false;
}

export function shouldGzip(
  req: Pick<IncomingMessage, 'method' | 'headers'>,
  status: number,
  headers: IncomingMessage['headers'],
): boolean {
  if (req.method === 'HEAD' || status < 200 || status === 204 || status === 304) return false;
  if (!acceptsGzip(req.headers['accept-encoding'])) return false;
  if (headers['content-encoding'] !== undefined) return false;
  if (!COMPRESSIBLE.test(headerText(headers['content-type']))) return false;
  const length = headers['content-length'];
  if (length !== undefined && Number(length) < MIN_COMPRESS_BYTES) return false;
  return /\bno-transform\b/i.test(headerText(headers['cache-control'])) === false;
}

function withVary(value: string | string[] | undefined): string {
  const existing = headerText(value);
  if (/\baccept-encoding\b/i.test(existing)) return existing;
  return existing === '' ? 'Accept-Encoding' : `${existing}, Accept-Encoding`;
}

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
    compress?: boolean;
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
      if (options.compress === true && shouldGzip(req, status, answer.headers)) {
        delete headers['content-length'];
        headers['content-encoding'] = 'gzip';
        headers.vary = withVary(headers.vary);
        res.writeHead(status, options.rewriteHeaders?.(headers) ?? headers);
        const gzip = createGzip({ level: 4, flush: zlibConstants.Z_SYNC_FLUSH });
        pipeline(answer, gzip, res, () => {});
        return;
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
