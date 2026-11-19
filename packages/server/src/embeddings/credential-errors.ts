import type { SemanticIndexStatus } from '@gitquire/core/schemas/api';

type EmbeddingsSecretStoreErrorCode = NonNullable<SemanticIndexStatus['keyStoreError']>;

export type EmbeddingsSecretStorePhase =
  | 'file_read'
  | 'file_write'
  | 'lock'
  | 'timeout'
  | 'operation';

export interface EmbeddingsSecretStoreDiagnostic {
  readonly phase: EmbeddingsSecretStorePhase;
  readonly name: string;
  readonly code: string;
}

const SAFE_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'YAMLParseError', 'AbortError']);
const SAFE_CODES = new Set(['ERR_SQLITE_ERROR', 'EACCES', 'EPERM', 'ENOENT', 'EIO', 'EBUSY']);

function diagnostic(
  phase: EmbeddingsSecretStorePhase,
  error: unknown,
): EmbeddingsSecretStoreDiagnostic {
  let name: unknown;
  let code: unknown;
  try {
    if (typeof error === 'object' && error !== null) {
      name = Reflect.get(error, 'name');
      code = Reflect.get(error, 'code');
    }
  } catch {}
  return Object.freeze({
    phase,
    name: typeof name === 'string' && SAFE_NAMES.has(name) ? name : 'unknown',
    code: typeof code === 'string' && SAFE_CODES.has(code) ? code : 'unknown',
  });
}

export class EmbeddingsSecretStoreError extends Error {
  readonly code: EmbeddingsSecretStoreErrorCode;
  declare readonly cause?: EmbeddingsSecretStoreDiagnostic;
  constructor(
    code: EmbeddingsSecretStoreErrorCode,
    phase?: EmbeddingsSecretStorePhase,
    error?: unknown,
  ) {
    const messages: Record<EmbeddingsSecretStoreErrorCode, string> = {
      lock_timeout:
        'Embeddings credential store is busy. Wait for the other operation to finish and try again.',
      file_access:
        'Embeddings credential files could not be read or written. Check their contents and permissions, then try again.',
      timeout:
        'Embeddings credential store timed out. Wait for the other operation to finish and try again.',
    };
    super(messages[code], phase === undefined ? undefined : { cause: diagnostic(phase, error) });
    this.name = 'EmbeddingsSecretStoreError';
    this.code = code;
    Object.defineProperty(this, 'code', { writable: false, configurable: false });
    Object.defineProperty(this, 'cause', {
      value: this.cause,
      writable: false,
      configurable: false,
    });
  }
}
