import { describe, expect, test } from 'vitest';
import { keyboardInset } from './viewport';

describe('keyboardInset', () => {
  test('measures the space the on-screen keyboard takes', () => {
    expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336);
    expect(keyboardInset(844, { height: 508, offsetTop: 40 })).toBe(296);
    expect(keyboardInset(844, null)).toBe(0);
  });
});
