import { describe, expect, test } from 'vitest';
import { STANDALONE_FEATURES } from '@/lib/gitquire/features';
import { connectAiMode, connectorUrl } from './ConnectAiSection';

describe('connectorUrl', () => {
  test('appends /mcp to the page origin', () => {
    expect(connectorUrl('https://wiki.example.com')).toBe('https://wiki.example.com/mcp');
    expect(connectorUrl('https://wiki.example.com/')).toBe('https://wiki.example.com/mcp');
  });
});

describe('connectAiMode', () => {
  test('offers the connector flow when the server accepts connectors', () => {
    const features = { ...STANDALONE_FEATURES, canUseTokens: true, canConnect: true };
    expect(connectAiMode(features)).toBe('connector');
  });

  test('falls back to personal tokens without connector support', () => {
    expect(connectAiMode({ ...STANDALONE_FEATURES, canUseTokens: true })).toBe('token-only');
  });

  test('offers the connector before the person has connected anything', () => {
    expect(
      connectAiMode({
        askAi: false,
        agentToken: false,
        connector: false,
        canUseTokens: true,
        canConnect: true,
      }),
    ).toBe('connector');
  });

  test('explains that sign-in is needed on a standalone server', () => {
    expect(connectAiMode(STANDALONE_FEATURES)).toBe('unavailable');
  });
});
