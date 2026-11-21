import type { IncomingMessage } from 'node:http';
import type { SessionUser } from './access-gate.ts';
import { isInternalRequest } from './internal-request.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Headers = Pick<IncomingMessage, 'headers'>;

const BEHIND_FRONT_DOOR_ENV = 'GITQUIRE_BEHIND_FRONT_DOOR';
export const PROXIED_PRINCIPAL_HEADER = 'x-gitquire-principal';
export const FORWARDED_PREFIX_HEADER = 'x-gitquire-prefix';
export const FORWARDED_VIEW_HEADER = 'x-gitquire-view';

const PREFIX_RE = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/;

export function behindFrontDoorFromEnv(env: Env): boolean {
  return ['1', 'on', 'true', 'yes'].includes(
    env[BEHIND_FRONT_DOOR_ENV]?.trim().toLowerCase() ?? '',
  );
}

const processBehindFrontDoor = behindFrontDoorFromEnv(process.env);

function behindFrontDoor(): boolean {
  return processBehindFrontDoor;
}

export function encodeProxiedUser(user: SessionUser): string {
  return Buffer.from(JSON.stringify(user), 'utf8').toString('base64url');
}

export function proxiedUser(req: Headers): SessionUser | undefined {
  const raw = req.headers[PROXIED_PRINCIPAL_HEADER];
  if (typeof raw !== 'string' || !isInternalRequest(req)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof value.id !== 'number' || typeof value.login !== 'string') return undefined;
    return {
      id: value.id,
      login: value.login,
      name: typeof value.name === 'string' ? value.name : value.login,
      avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : '',
      ...(value.repoAdmin === true ? { repoAdmin: true } : {}),
    };
  } catch {
    return undefined;
  }
}

function isValidPrefix(value: string): boolean {
  return PREFIX_RE.test(value) && !value.split('/').some((part) => part === '.' || part === '..');
}

export function forwardedPrefix(req: Headers, behind: boolean = behindFrontDoor()): string {
  if (!behind) return '';
  const raw = req.headers[FORWARDED_PREFIX_HEADER];
  if (typeof raw !== 'string' || !isInternalRequest(req)) return '';
  return isValidPrefix(raw) ? raw : '';
}

export function forwardedView(req: Headers): string | undefined {
  const raw = req.headers[FORWARDED_VIEW_HEADER];
  if (typeof raw !== 'string' || raw === '' || !isInternalRequest(req)) return undefined;
  return raw;
}

export interface RequestPerson {
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  isAdminRequest: (req: IncomingMessage) => boolean;
  agentOwner: (req: IncomingMessage) => SessionUser | undefined;
}

export interface RequestPersonSources {
  behindFrontDoor: boolean;
  cookieUser?: (req: IncomingMessage) => SessionUser | undefined;
  agentTokenOwner?: (req: IncomingMessage) => SessionUser | undefined;
  isAdmin?: (user: SessionUser) => boolean;
}

export function createRequestPerson(sources: RequestPersonSources): RequestPerson {
  if (sources.behindFrontDoor) {
    return {
      sessionUser: proxiedUser,
      isAdminRequest: (req) => proxiedUser(req)?.repoAdmin === true,
      agentOwner: proxiedUser,
    };
  }
  const cookieUser = sources.cookieUser ?? (() => undefined);
  const isAdmin = sources.isAdmin ?? (() => false);
  return {
    sessionUser: cookieUser,
    isAdminRequest: (req) => {
      const user = cookieUser(req);
      return user !== undefined && isAdmin(user);
    },
    agentOwner: (req) => sources.agentTokenOwner?.(req) ?? proxiedUser(req),
  };
}
