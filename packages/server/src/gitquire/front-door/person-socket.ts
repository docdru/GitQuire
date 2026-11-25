import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GateLogger } from '../access-gate.ts';
import { sendJson } from '../http-util.ts';
import { PERSON_PATH_PREFIX } from '../people/door-client.ts';
import { isAgentMode, type PersonSettings } from '../people/settings.ts';
import { PERSON_TICKET_HEADER, type PersonTickets } from '../people/ticket.ts';

const MAX_BODY_BYTES = 64 * 1024;

export interface PersonQuestion {
  person: string;
  wikiKey: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export type PersonAnswer = { status: number; body: unknown } | undefined;

export type PersonQuestionHandler = (
  question: PersonQuestion,
) => PersonAnswer | Promise<PersonAnswer>;

export interface PersonSocketDeps {
  tickets: PersonTickets;
  settings: PersonSettings;
  handlers?: readonly PersonQuestionHandler[];
  log: GateLogger;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function settingsAnswer(settings: PersonSettings, question: PersonQuestion): PersonAnswer {
  const { person, method, path, body } = question;
  if (path === 'settings' && method === 'GET') {
    return { status: 200, body: { yaml: settings.read(person) } };
  }
  if (path === 'settings' && method === 'PUT') {
    if (typeof body.yaml !== 'string') return { status: 400, body: { error: 'invalid-settings' } };
    const problem = settings.write(person, body.yaml);
    return problem === undefined
      ? { status: 200, body: { saved: true } }
      : { status: 400, body: { error: `settings-${problem}` } };
  }
  if (path === 'agent-mode' && method === 'GET') {
    return { status: 200, body: { mode: settings.agentMode(person) } };
  }
  if (path === 'agent-mode' && method === 'PUT') {
    if (!isAgentMode(body.mode)) return { status: 400, body: { error: 'invalid-mode' } };
    return { status: 200, body: { mode: settings.setAgentMode(person, body.mode) } };
  }
  return undefined;
}

export function createPersonSocketHandler(
  deps: PersonSocketDeps,
): (req: IncomingMessage, res: ServerResponse, wikiKey: string, path: string) => void {
  const handlers: PersonQuestionHandler[] = [
    (question) => settingsAnswer(deps.settings, question),
    ...(deps.handlers ?? []),
  ];
  return (req, res, wikiKey, path) => {
    const raw = req.headers[PERSON_TICKET_HEADER];
    const person = deps.tickets.personOf(typeof raw === 'string' ? raw : undefined, wikiKey);
    if (person === undefined) {
      sendJson(res, 403, { error: 'no-ticket' });
      return;
    }
    const method = req.method ?? 'GET';
    readBody(req)
      .then(async (body) => {
        const question: PersonQuestion = {
          person,
          wikiKey,
          method,
          path: path.slice(PERSON_PATH_PREFIX.length),
          body,
        };
        for (const handler of handlers) {
          const answer = await handler(question);
          if (answer !== undefined) {
            sendJson(res, answer.status, answer.body);
            return;
          }
        }
        sendJson(res, 404, { error: 'not-found' });
      })
      .catch((err: unknown) => {
        deps.log.warn({ err, wiki: wikiKey, path }, '[gitquire-people] door question failed');
        if (!res.headersSent) sendJson(res, 400, { error: 'bad-request' });
      });
  };
}
