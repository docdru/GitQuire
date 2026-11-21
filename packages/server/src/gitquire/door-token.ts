import { request } from 'node:http';
import { GitHubUnavailableError } from './github-app.ts';
import { parseGitHubRepo } from './github-auth-config.ts';
import { parseHostKind } from './host/names.ts';
import type { HostKind, HostRepo } from './host/types.ts';
import { internalRequestHeaders } from './internal-request.ts';
import { behindFrontDoorFromEnv } from './request-person.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const DOOR_TOKEN_SOCKET_ENV = 'GITQUIRE_DOOR_TOKEN_SOCKET';
export const DOOR_TOKEN_PATH = '/token';

export interface DoorSyncConfig {
  host: HostKind;
  repo: HostRepo;
  branch: string | undefined;
  webUrl: string;
  apiUrl: string;
  gitHost: string;
  socket: string;
}

export interface DoorToken {
  token: string;
  expiresAt: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function resolveDoorSyncConfig(env: Env): DoorSyncConfig | undefined {
  if (!behindFrontDoorFromEnv(env)) return undefined;
  const socket = nonEmpty(env[DOOR_TOKEN_SOCKET_ENV]);
  const repo = parseGitHubRepo(env.GITQUIRE_REPO);
  if (socket === undefined || repo === undefined) return undefined;
  const host = parseHostKind(env);
  const webUrl = stripTrailingSlash(
    host === 'forgejo'
      ? (nonEmpty(env.GITQUIRE_HOST_URL) ?? '')
      : (nonEmpty(env.GITQUIRE_GITHUB_WEB_URL) ?? 'https://github.com'),
  );
  const apiUrl = stripTrailingSlash(
    host === 'forgejo'
      ? (nonEmpty(env.GITQUIRE_HOST_API_URL) ?? `${webUrl}/api/v1`)
      : (nonEmpty(env.GITQUIRE_GITHUB_API_URL) ?? 'https://api.github.com'),
  );
  return {
    host,
    repo,
    branch: nonEmpty(env.GITQUIRE_BRANCH),
    webUrl,
    apiUrl,
    gitHost: new URL(webUrl).host,
    socket,
  };
}

export function parseDoorToken(status: number, body: string): DoorToken | undefined {
  if (status !== 200) return undefined;
  try {
    const value = JSON.parse(body) as { token?: unknown; expiresAt?: unknown };
    if (typeof value.token !== 'string' || value.token === '') return undefined;
    if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return undefined;
    return { token: value.token, expiresAt: value.expiresAt };
  } catch {
    return undefined;
  }
}

export function fetchDoorToken(socket: string): Promise<DoorToken> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: DOOR_TOKEN_PATH,
        method: 'GET',
        headers: internalRequestHeaders(),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const token = parseDoorToken(status, Buffer.concat(chunks).toString('utf8'));
          if (token !== undefined) {
            resolve(token);
          } else {
            reject(
              new GitHubUnavailableError(
                `The front door has no token for this wiki right now (HTTP ${status}).`,
              ),
            );
          }
        });
        res.on('error', (err) => reject(new GitHubUnavailableError(err.message)));
      },
    );
    req.on('error', (err) =>
      reject(new GitHubUnavailableError(`Could not reach the front door: ${err.message}`)),
    );
    req.setTimeout(30_000, () => req.destroy(new Error('No answer in time.')));
    req.end();
  });
}
