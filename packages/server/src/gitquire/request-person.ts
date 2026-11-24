import type { IncomingMessage } from 'node:http';
import type { SessionUser } from './access-gate.ts';
import { isInternalRequest } from './internal-request.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Headers = Pick<IncomingMessage, 'headers'>;

const BEHIND_FRONT_DOOR_ENV = 'GITQUIRE_BEHIND_FRONT_DOOR';
export const PROXIED_PRINCIPAL_HEADER = 'x-gitquire-principal';
export const FORWARDED_PREFIX_HEADER = 'x-gitquire-prefix';
export const FORWARDED_VIEW_HEADER = 'x-gitquire-view';
export const FORWARDED_AGENTS_HEADER = 'x-gitquire-agents';
export const FORWARDED_AGENTS_HOST_HEADER = 'x-gitquire-agents-host';

const AGENTS_HOST_RE = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const PREFIX_RE = /^(?:\/[A-Za-z0-9._~-]+)+$/;

export function behindFrontDoorFromEnv(env: Env): boolean {
  return ['1', 'on', 'true', 'yes'].includes(
    env[BEHIND_FRONT_DOOR_ENV]?.trim().toLowerCase() ?? '',
  );
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

export function forwardedPrefix(req: Headers, behind: boolean): string {
  if (!behind) return '';
  const raw = req.headers[FORWARDED_PREFIX_HEADER];
  if (typeof raw !== 'string' || !isInternalRequest(req)) return '';
  return isValidPrefix(raw) ? raw : '';
}

const requestPrefixes = new WeakMap<object, string>();

export function bindRequestPrefix(req: object, prefix: string): void {
  if (prefix !== '') requestPrefixes.set(req, prefix);
}

export function requestPrefix(req: object): string {
  return requestPrefixes.get(req) ?? '';
}

export function forwardedView(req: Headers, behind: boolean): string | undefined {
  if (!behind) return undefined;
  const raw = req.headers[FORWARDED_VIEW_HEADER];
  if (typeof raw !== 'string' || raw === '' || !isInternalRequest(req)) return undefined;
  return raw;
}

export interface AgentFeatures {
  agentToken: boolean;
  connector: boolean;
  canUseTokens: boolean;
  canConnect: boolean;
}

const AGENT_FEATURE_FLAGS: Record<keyof AgentFeatures, string> = {
  agentToken: 'token',
  connector: 'connector',
  canUseTokens: 'tokens',
  canConnect: 'connect',
};

export function encodeAgentFeatures(features: AgentFeatures): string {
  return (Object.keys(AGENT_FEATURE_FLAGS) as (keyof AgentFeatures)[])
    .filter((name) => features[name])
    .map((name) => AGENT_FEATURE_FLAGS[name])
    .join(',');
}

export function forwardedAgentFeatures(req: Headers, behind: boolean): AgentFeatures {
  const raw = req.headers[FORWARDED_AGENTS_HEADER];
  const flags =
    behind && typeof raw === 'string' && isInternalRequest(req)
      ? new Set(raw.split(',').map((flag) => flag.trim()))
      : new Set<string>();
  return {
    agentToken: flags.has(AGENT_FEATURE_FLAGS.agentToken),
    connector: flags.has(AGENT_FEATURE_FLAGS.connector),
    canUseTokens: flags.has(AGENT_FEATURE_FLAGS.canUseTokens),
    canConnect: flags.has(AGENT_FEATURE_FLAGS.canConnect),
  };
}

export function forwardedAgentPaths(
  req: Headers,
  behind: boolean,
): { agentsPath: string; mcpPath: string } | undefined {
  const raw = req.headers[FORWARDED_AGENTS_HOST_HEADER];
  if (!behind || typeof raw !== 'string' || !isInternalRequest(req)) return undefined;
  if (!AGENTS_HOST_RE.test(raw)) return undefined;
  return { agentsPath: `/auth/${raw}/agents`, mcpPath: `/mcp/${raw}` };
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
