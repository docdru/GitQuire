import { request } from 'node:http';
import { internalRequestHeaders } from '../internal-request.ts';
import { PERSON_TICKET_HEADER } from './ticket.ts';

export const PERSON_PATH_PREFIX = '/person/';

export interface DoorAnswer {
  status: number;
  body: unknown;
}

export class DoorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoorUnavailableError';
  }
}

export type AskDoor = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  ticket: string,
  body?: unknown,
) => Promise<DoorAnswer>;

export function doorAsker(socket: string, timeoutMs = 30_000): AskDoor {
  return (method, path, ticket, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      const req = request(
        {
          socketPath: socket,
          path: `${PERSON_PATH_PREFIX}${path}`,
          method,
          headers: {
            ...internalRequestHeaders(),
            [PERSON_TICKET_HEADER]: ticket,
            ...(payload === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = text === '' ? undefined : JSON.parse(text);
            } catch {
              parsed = undefined;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on('error', (err) => reject(new DoorUnavailableError(err.message)));
        },
      );
      req.on('error', (err) =>
        reject(new DoorUnavailableError(`Could not reach the front door: ${err.message}`)),
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('No answer in time.')));
      req.end(payload);
    });
}
