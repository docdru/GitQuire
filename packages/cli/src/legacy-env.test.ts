import { expect, test } from 'vitest';
import { adoptLegacyEnv, legacyEnvNotice } from './legacy-env.ts';

test('an old OK_ variable is copied to its GITQUIRE_ name and reported', () => {
  const env: Record<string, string | undefined> = {
    OK_ALLOW_EXTERNAL: '1',
    OK_EXTERNAL_URL: 'https://wiki.example.com',
    PATH: '/usr/bin',
  };
  expect(adoptLegacyEnv(env)).toEqual(['OK_ALLOW_EXTERNAL', 'OK_EXTERNAL_URL']);
  expect(env.GITQUIRE_ALLOW_EXTERNAL).toBe('1');
  expect(env.GITQUIRE_EXTERNAL_URL).toBe('https://wiki.example.com');
  expect(env.OK_ALLOW_EXTERNAL).toBe('1');
});

test('the new name wins when both are set, and nothing is reported', () => {
  const env: Record<string, string | undefined> = {
    OK_BIND: '127.0.0.1',
    GITQUIRE_BIND: '0.0.0.0',
  };
  expect(adoptLegacyEnv(env)).toEqual([]);
  expect(env.GITQUIRE_BIND).toBe('0.0.0.0');
});

test('variables without the old prefix are left alone', () => {
  const env: Record<string, string | undefined> = {
    PORT: '8080',
    BOOK_TITLE: 'x',
    GITQUIRE_REPO: 'o/r',
  };
  expect(adoptLegacyEnv(env)).toEqual([]);
  expect(env).toEqual({ PORT: '8080', BOOK_TITLE: 'x', GITQUIRE_REPO: 'o/r' });
});

test('the notice names both spellings', () => {
  expect(legacyEnvNotice('OK_BIND')).toBe(
    'The environment variable OK_BIND is now GITQUIRE_BIND. The old name still works for now and will be removed in a later version.\n',
  );
});
