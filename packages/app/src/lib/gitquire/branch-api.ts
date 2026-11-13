import type { CheckoutResponse } from '@inkeep/open-knowledge-core/schemas/api';

export interface GitQuireBranches {
  current: string | null;
  base: string;
  local: string[];
  remoteOnly: string[];
  github: boolean;
  currentMerged?: boolean;
}

export interface GitQuirePull {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  draft: boolean;
  author: string;
  updatedAt: string;
}

export interface GitQuirePulls {
  configured: boolean;
  pulls: GitQuirePull[];
}

export class GitQuireApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GitQuireApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiDeps {
  fetch?: typeof fetch;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown },
  deps: ApiDeps,
): Promise<T> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(path, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const body = (parsed ?? {}) as { error?: unknown; message?: unknown; detail?: unknown };
    const code = typeof body.error === 'string' ? body.error : `http-${res.status}`;
    const message =
      typeof body.message === 'string'
        ? body.message
        : typeof body.detail === 'string'
          ? body.detail
          : `Request failed (HTTP ${res.status}).`;
    throw new GitQuireApiError(res.status, code, message);
  }
  return parsed as T;
}

export function fetchBranches(deps: ApiDeps = {}): Promise<GitQuireBranches> {
  return request('/api/gitquire/branches', {}, deps);
}

export function fetchPulls(deps: ApiDeps = {}): Promise<GitQuirePulls> {
  return request('/api/gitquire/pulls', {}, deps);
}

export function createBranch(
  name: string,
  from: string | undefined,
  deps: ApiDeps = {},
): Promise<{ name: string; from: string }> {
  return request('/api/gitquire/branches', { method: 'POST', body: { name, from } }, deps);
}

export function checkoutBranch(branch: string, deps: ApiDeps = {}): Promise<CheckoutResponse> {
  return request('/api/git/checkout', { method: 'POST', body: { branch } }, deps);
}

export interface OpenPullRequestInput {
  title: string;
  body: string;
  draft: boolean;
}

export interface OpenPullRequestDeps extends ApiDeps {
  push?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  pushWaitsMs?: readonly number[];
}

const DEFAULT_PUSH_WAITS_MS = [2000, 3000, 5000, 10_000, 15_000] as const;

export async function openPullRequest(
  input: OpenPullRequestInput,
  deps: OpenPullRequestDeps = {},
): Promise<GitQuirePull> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waits = deps.pushWaitsMs ?? DEFAULT_PUSH_WAITS_MS;
  await deps.push?.().catch(() => undefined);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await request<{ pull: GitQuirePull }>(
        '/api/gitquire/pulls',
        { method: 'POST', body: input },
        deps,
      );
      return result.pull;
    } catch (err) {
      const wait = waits[attempt];
      if (!(err instanceof GitQuireApiError) || err.code !== 'branch-not-pushed') throw err;
      if (wait === undefined) throw err;
      await sleep(wait);
    }
  }
}

export const gitquireRequest = request;
