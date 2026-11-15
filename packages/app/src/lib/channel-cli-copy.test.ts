import { afterEach, describe, expect, test, vi } from 'vitest';
import { okCliCommandName, okUserHomeLabel } from './channel-cli-copy';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('channel CLI copy', () => {
  test('names Stable without a desktop bridge', () => {
    expect(okCliCommandName()).toBe('ok');
    expect(okUserHomeLabel('secrets.yml')).toBe('~/.ok/secrets.yml');
  });

  test('falls back to Stable for a command no channel owns', () => {
    vi.stubGlobal('window', { okDesktop: { cliCommandName: 'rm -rf' } });
    expect(okCliCommandName()).toBe('ok');
  });
});
