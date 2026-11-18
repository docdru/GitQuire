import { posix } from 'node:path';
import { describe, expect, test } from 'vitest';
import { escapesRoot, isWithinDir, toPosix } from './path-utils.ts';

describe('toPosix', () => {
  test('rewrites Windows backslashes to forward slashes', () => {
    expect(toPosix('C:\\Users\\mike\\Documents\\kb\\asdf')).toBe('C:/Users/mike/Documents/kb/asdf');
    expect(toPosix('research\\notes.md')).toBe('research/notes.md');
  });

  test('is a no-op on already-POSIX paths', () => {
    expect(toPosix('research/notes.md')).toBe('research/notes.md');
    expect(toPosix('/Users/mike/kb')).toBe('/Users/mike/kb');
    expect(toPosix('')).toBe('');
  });

  test('normalizes mixed separators', () => {
    expect(toPosix('C:\\Users\\mike\\kb/asdf')).toBe('C:/Users/mike/kb/asdf');
  });
});

describe('isWithinDir', () => {
  test('a child is contained', () => {
    expect(isWithinDir('/data/kb/research/a.md', '/data/kb')).toBe(true);
  });

  test('the directory itself is within itself', () => {
    expect(isWithinDir('/data/kb', '/data/kb')).toBe(true);
  });

  test('a sibling or escaping path is rejected', () => {
    expect(isWithinDir('/data/other/x', '/data/kb')).toBe(false);
    expect(isWithinDir('/data/kbase/x', '/data/kb')).toBe(false);
  });
});

describe('escapesRoot', () => {
  test('a parent-relative path escapes', () => {
    expect(escapesRoot(posix.relative('/tmp/ok', '/data/Downloads'))).toBe(true);
    expect(escapesRoot('..')).toBe(true);
  });

  test('an absolute path escapes', () => {
    expect(escapesRoot('/etc/passwd')).toBe(true);
  });

  test('a child and the root itself are contained', () => {
    expect(escapesRoot('hwi_828')).toBe(false);
    expect(escapesRoot('')).toBe(false);
  });

  test('a name that merely starts with two dots is contained', () => {
    expect(escapesRoot('..notes/a.md')).toBe(false);
  });
});
