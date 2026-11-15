import { describe, expect, it } from 'vitest';
import { assetOpenRefusalRevealsInstead } from './desktop-bridge.ts';

describe('assetOpenRefusalRevealsInstead', () => {
  it('reveals refusals of items that exist but must not be opened', () => {
    expect(assetOpenRefusalRevealsInstead('extension-blocked')).toBe(true);
    expect(assetOpenRefusalRevealsInstead('not-a-file')).toBe(true);
  });

  it('does not reveal escapes, missing items or OS handler failures', () => {
    expect(assetOpenRefusalRevealsInstead('path-escape')).toBe(false);
    expect(assetOpenRefusalRevealsInstead('not-found')).toBe(false);
    expect(assetOpenRefusalRevealsInstead('resolve-error')).toBe(false);
  });

  it('does not reveal or throw on a reason a newer desktop sends', () => {
    const fromNewerDesktop = 'quarantined' as Parameters<typeof assetOpenRefusalRevealsInstead>[0];
    expect(assetOpenRefusalRevealsInstead(fromNewerDesktop)).toBe(false);
  });
});
