import { parse as parseToml } from 'smol-toml';
import { isObject } from '../utils/is-object.ts';

export interface TomlUpsertResult {
  text: string;
  existed: boolean;
}

interface TomlConfigEngineBase {
  parseToObject(raw: string): Record<string, unknown>;
}

interface NativeTomlConfigEngine extends TomlConfigEngineBase {
  readonly backend: 'native';
  upsertEntry(raw: string, serverName: string, entry: Record<string, unknown>): TomlUpsertResult;
  removeEntry(raw: string, serverName: string): TomlUpsertResult;
  removeEntryKey(raw: string, serverName: string, key: string): TomlUpsertResult;
}

interface FallbackTomlConfigEngine extends TomlConfigEngineBase {
  readonly backend: 'fallback';
}

export type TomlConfigEngine = NativeTomlConfigEngine | FallbackTomlConfigEngine;

function assertTable(parsed: unknown): Record<string, unknown> {
  if (!isObject(parsed)) throw new Error('TOML root is not a table');
  return parsed;
}

const fallbackEngine: FallbackTomlConfigEngine = {
  backend: 'fallback',
  parseToObject(raw) {
    return assertTable(parseToml(raw));
  },
};

let cachedEngine: TomlConfigEngine | null = null;

export function getTomlConfigEngine(): TomlConfigEngine {
  return cachedEngine ?? fallbackEngine;
}

export function setTomlConfigEngineForTesting(engine: TomlConfigEngine | null): void {
  cachedEngine = engine;
}
