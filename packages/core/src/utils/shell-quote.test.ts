import { describe, expect, test } from 'vitest';
import { shellSingleQuote } from './shell-quote.ts';

describe('shellSingleQuote', () => {
  test('wraps a plain string in single quotes', () => {
    expect(shellSingleQuote('abc')).toBe("'abc'");
  });

  test('closes, escapes and reopens around an embedded single quote', () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
  });
});
