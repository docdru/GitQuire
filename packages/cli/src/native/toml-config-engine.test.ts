import { afterEach, describe, expect, test } from 'vitest';
import { getTomlConfigEngine, setTomlConfigEngineForTesting } from './toml-config-engine.ts';

describe('getTomlConfigEngine', () => {
  afterEach(() => {
    setTomlConfigEngineForTesting(null);
  });

  test('is the read-only JS engine', () => {
    const engine = getTomlConfigEngine();
    expect(engine.backend).toBe('fallback');
    expect(engine.parseToObject('[mcp_servers.a]\ncommand = "x"\n')).toEqual({
      mcp_servers: { a: { command: 'x' } },
    });
  });

  test('throws on malformed TOML', () => {
    expect(() => getTomlConfigEngine().parseToObject('[unclosed')).toThrow();
  });

  test('a test can swap the engine and restore the default', () => {
    const stub = { backend: 'fallback' as const, parseToObject: () => ({ stub: true }) };
    setTomlConfigEngineForTesting(stub);
    expect(getTomlConfigEngine().parseToObject('')).toEqual({ stub: true });
    setTomlConfigEngineForTesting(null);
    expect(getTomlConfigEngine().backend).toBe('fallback');
  });
});
