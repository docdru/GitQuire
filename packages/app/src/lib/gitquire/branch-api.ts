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

export const gitquireRequest = request;
