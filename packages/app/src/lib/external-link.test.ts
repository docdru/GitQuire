import { describe, expect, test, vi } from 'vitest';
import { openExternalUrl } from './external-link.ts';

describe('openExternalUrl', () => {
  test('falls back to window.open with the new-tab + noopener features', () => {
    const openWindow = vi.fn(() => null);
    openExternalUrl('https://example.com', { openWindow });
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });
});

describe('openExternalUrl — structural scheme gate (internal)', () => {
  test('an unsafe scheme is refused — never reaches window.open', () => {
    const openWindow = vi.fn(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: exercising the security gate with a hostile scheme
    openExternalUrl('javascript:alert(1)' as any, { openWindow });
    expect(openWindow).not.toHaveBeenCalled();
  });
});
