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
    const features = { ...STANDALONE_FEATURES, canUseTokens: true, canConnect: true };
    expect(connectClaudeMode(features)).toBe('connector');
  });

  test('falls back to personal tokens without connector support', () => {
    expect(connectClaudeMode({ ...STANDALONE_FEATURES, canUseTokens: true })).toBe('token-only');
  });

  test('offers the connector before the person has connected anything', () => {
    expect(
      connectClaudeMode({
        askAi: false,
        agentToken: false,
        connector: false,
        canUseTokens: true,
        canConnect: true,
      }),
    ).toBe('connector');
  });

  test('explains that sign-in is needed on a standalone server', () => {
    expect(connectClaudeMode(STANDALONE_FEATURES)).toBe('unavailable');
  });
});
