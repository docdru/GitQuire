import type { SerializedError, SerializedErrorTruncation } from '@inkeep/open-knowledge-core';

const MAX_CAUSE_DEPTH = 5;

const HOME_PATH_PATTERNS = [
  { regex: /\/Users\/[^/]+\//g, replacement: '~/' },
  { regex: /\/home\/[^/]+\//g, replacement: '~/' },
  { regex: /C:\\\\Users\\\\[^\\\\]+\\\\/g, replacement: '~\\' },
  { regex: /C:\\Users\\[^\\]+\\/g, replacement: '~\\' },
];

function scrubPaths(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let result = value;
  for (const { regex, replacement } of HOME_PATH_PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

export function serializeError(
  err: unknown,
  depth = 0,
  visited = new WeakSet<object>(),
): SerializedError | SerializedErrorTruncation {
  if (depth >= MAX_CAUSE_DEPTH) {
    return {
      name: 'SerializedError.CauseDepthExceeded',
      message: `cause chain depth > ${MAX_CAUSE_DEPTH}; truncated`,
    };
  }

  if (err !== null && typeof err === 'object') {
    if (visited.has(err)) {
      return {
        name: 'SerializedError.CauseCycle',
        message: 'cyclic cause; truncated',
      };
    }
    visited.add(err);
  }

  if (err instanceof Error) {
    const serialized: SerializedError = {
      name: err.name,
      message: scrubPaths(err.message) ?? '',
      stack: scrubPaths(err.stack),
      code: (err as { code?: string }).code,
      cause: err.cause !== undefined ? serializeError(err.cause, depth + 1, visited) : undefined,
    };
    return serialized;
  }

  if (err === null || err === undefined) {
    return {
      name: 'UnknownError',
      message: String(err),
    };
  }

  if (typeof err === 'string') {
    return {
      name: 'StringError',
      message: scrubPaths(err) ?? err,
    };
  }

  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    return {
      name: String(obj.name ?? 'ObjectError'),
      message: scrubPaths(String(obj.message ?? '')) ?? '',
      stack: scrubPaths(obj.stack as string | undefined),
      code: obj.code as string | undefined,
      cause: obj.cause !== undefined ? serializeError(obj.cause, depth + 1, visited) : undefined,
    };
  }

  return {
    name: 'UnknownError',
    message: String(err),
  };
}
