import type { IncomingMessage, ServerResponse } from 'node:http';

export function pathOf(req: IncomingMessage): { path: string; search: string } {
  const url = new URL(req.url ?? '/', 'http://gitquire.invalid');
  return { path: url.pathname, search: url.search };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · GitQuire</title><style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5;color:#1f2328}a{color:#0969da}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}pre{background:#f6f8fa;padding:.75rem;border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}table{border-collapse:collapse;width:100%;font-size:.9em}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #d0d7de;vertical-align:top}button{font:inherit;padding:.3rem .8rem;cursor:pointer}input[type=text]{font:inherit;padding:.3rem;width:100%;box-sizing:border-box}.muted{color:#59636e;font-size:.9em}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
  );
}

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

export function redirect(
  res: ServerResponse,
  location: string,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

export function wantsHtml(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return (req.headers.accept ?? '').includes('text/html');
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? undefined : match[1].trim();
}

const MAX_FORM_BYTES = 16 * 1024;

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) throw new Error('form-too-large');
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function isSameOriginRequest(req: IncomingMessage, externalUrl: URL): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === 'null') {
    const referer = req.headers.referer;
    if (referer === undefined) return origin === undefined;
    try {
      return new URL(referer).origin === externalUrl.origin;
    } catch {
      return false;
    }
  }
  return origin === externalUrl.origin;
}
