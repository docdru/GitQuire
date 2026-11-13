import { describe, expect, test } from 'vitest';
import { STANDALONE_FEATURES } from '@/lib/gitquire/features';
import { connectClaudeMode, connectorUrl } from './ConnectClaudeSection';

describe('connectorUrl', () => {
  test('appends /mcp to the page origin', () => {
    expect(connectorUrl('https://wiki.example.com')).toBe('https://wiki.example.com/mcp');
    expect(connectorUrl('https://wiki.example.com/')).toBe('https://wiki.example.com/mcp');
  });
});

describe('connectClaudeMode', () => {
  test('offers the connector flow when the server accepts connectors', () => {
    expect(connectClaudeMode({ askAi: false, agentToken: true, connector: true })).toBe(
      'connector',
    );
  });

  test('falls back to personal tokens without connector support', () => {
    expect(connectClaudeMode({ askAi: false, agentToken: true, connector: false })).toBe(
      'token-only',
    );
  });

  test('explains that sign-in is needed on a standalone server', () => {
    expect(connectClaudeMode(STANDALONE_FEATURES)).toBe('unavailable');
  });
});
