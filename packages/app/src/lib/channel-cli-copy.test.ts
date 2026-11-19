import { afterEach, describe, expect, test, vi } from 'vitest';
import { okCliCommandName, okUserHomeLabel } from './channel-cli-copy';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('channel CLI copy', () => {
  test('names the gq command and the ~/.gitquire home', () => {
    expect(okCliCommandName()).toBe('gq');
    expect(okUserHomeLabel('secrets.yml')).toBe('~/.gitquire/secrets.yml');
  });
});
