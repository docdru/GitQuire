import type { IncomingMessage } from 'node:http';
import { forwardedPrefix } from './gitquire/request-person.ts';

export function collabUrlFromRequestHeaders(
  headers: IncomingMessage['headers'],
  prefix: string = forwardedPrefix({ headers }),
): string | null {
  const host = headers.host;
  if (!host) return null;
  const fwd = headers['x-forwarded-proto'];
  const proto = Array.isArray(fwd) ? fwd[0] : fwd;
  return `${proto === 'https' ? 'wss' : 'ws'}://${host}${prefix}/collab`;
}
