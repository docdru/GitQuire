import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type AccessGate,
  type GateLogger,
  isInAppAgentPath,
  isPublicAsset,
  meBody,
  principalFromUser,
  refuseForPerson,
} from './access-gate.ts';
import { chatKeySecretFromEnv } from './chat/key-secret.ts';
import { loginSet, parseGitHubRepo } from './github-auth-config.ts';
import { pathOf, sendJson } from './http-util.ts';
import { isInternalRequest } from './internal-request.ts';
import { bindRequestPrincipal } from './principal-directory.ts';
import {
  bindRequestPrefix,
  createRequestPerson,
  forwardedAgentFeatures,
  forwardedAgentPaths,
  forwardedPrefix,
} from './request-person.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface BehindFrontDoorSettings {
  repo: string | undefined;
  adminLogins: ReadonlySet<string>;
  aiChat: boolean;
}

export function resolveBehindFrontDoorSettings(env: Env): BehindFrontDoorSettings {
  const repo = parseGitHubRepo(env.GITQUIRE_REPO);
  const aiChat =
    !['0', 'off', 'false', 'no'].includes(env.GITQUIRE_AI_CHAT?.trim().toLowerCase() ?? '') &&
    chatKeySecretFromEnv(env) !== undefined;
  return {
    repo: repo === undefined ? undefined : `${repo.owner}/${repo.name}`,
    adminLogins: loginSet(env.GITQUIRE_ADMINS),
    aiChat,
  };
}

const HEALTH_PATHS = new Set(['/healthz', '/readyz']);

function rawPathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function isAmbiguousCollabPath(raw: string, path: string): boolean {
  return raw !== path && (raw.includes('/collab') || path.startsWith('/collab'));
}

function refuseUpgrade(socket: Duplex, status: string): false {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
  return false;
}

export function createBehindFrontDoorGate(
  settings: BehindFrontDoorSettings,
  deps: { log: GateLogger; now?: () => number },
): AccessGate {
  const now = deps.now ?? Date.now;
  const person = createRequestPerson({ behindFrontDoor: true });

  function handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const { path } = pathOf(req);
    const raw = rawPathOf(req);
    if (HEALTH_PATHS.has(raw)) return false;
    if (isAmbiguousCollabPath(raw, path)) {
      sendJson(res, 400, { error: 'ambiguous-path' });
      return true;
    }
    if (!isInternalRequest(req)) {
      deps.log.warn(
        { path },
        '[gitquire-auth] refused a request that did not come through the front door',
      );
      sendJson(res, 403, { error: 'front-door-only' });
      return true;
    }
    bindRequestPrefix(req, forwardedPrefix(req, true));
    if (isPublicAsset(path, req.method)) return false;
    const user = person.sessionUser(req);
    if (path.startsWith('/auth/')) {
      if (path !== '/auth/me') {
        sendJson(res, 404, { error: 'sign-in-at-front-door' });
      } else if (user === undefined) {
        sendJson(res, 401, { error: 'not-signed-in' });
      } else {
        sendJson(
          res,
          200,
          meBody(user, {
            admin: user.repoAdmin === true,
            adminLogins: settings.adminLogins,
            repo: settings.repo,
            features: {
              aiChat: settings.aiChat,
              ...forwardedAgentFeatures(req, true),
              ...forwardedAgentPaths(req, true),
            },
          }),
        );
      }
      return true;
    }
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      if (user !== undefined) {
        bindRequestPrincipal(req, principalFromUser(user));
        return false;
      }
      sendJson(res, 401, { error: 'mcp-token-required' });
      return true;
    }
    if (user === undefined) {
      if (path.startsWith('/api/')) return false;
      sendJson(res, 401, { error: 'not-signed-in' });
      return true;
    }
    return refuseForPerson(req, res, path, user, user.repoAdmin === true, now);
  }

  function admitUpgrade(req: IncomingMessage, socket: Duplex): boolean {
    const { path } = pathOf(req);
    if (isAmbiguousCollabPath(rawPathOf(req), path)) {
      deps.log.warn({ path }, '[gitquire-auth] refused a websocket upgrade with an ambiguous path');
      return refuseUpgrade(socket, '400 Bad Request');
    }
    if (!isInternalRequest(req)) {
      deps.log.warn(
        { path },
        '[gitquire-auth] refused a websocket upgrade that did not come through the front door',
      );
      return refuseUpgrade(socket, '403 Forbidden');
    }
    if (!path.startsWith('/collab')) return true;
    if (isInAppAgentPath(path)) {
      deps.log.warn({ path }, '[gitquire-auth] refused in-app agent session');
      return refuseUpgrade(socket, '403 Forbidden');
    }
    if (person.sessionUser(req) !== undefined) return true;
    deps.log.warn({ path }, '[gitquire-auth] refused a websocket upgrade without a person');
    return refuseUpgrade(socket, '401 Unauthorized');
  }

  return { handleRequest, admitUpgrade, ...person };
}
