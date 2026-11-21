import { afterEach, describe, expect, it } from 'vitest';
import { principalIdForUser } from '../principal-directory.ts';
import {
  gitHubNames,
  HostConfigError,
  hostNames,
  hostNamesFromEnv,
  resetHostNames,
  setHostNames,
} from './names.ts';

afterEach(() => {
  resetHostNames();
});

describe('host names', () => {
  it('defaults to GitHub with the ids and emails GitQuire has always used', () => {
    const names = hostNamesFromEnv({});
    expect(names.kind).toBe('github');
    expect(names.label).toBe('GitHub');
    expect(names.idPrefix).toBe('github-');
    expect(names.noreplyEmail({ id: 42, login: 'alice' })).toBe(
      '42+alice@users.noreply.github.com',
    );
    expect(hostNames().noreplyEmail({ id: 42, login: 'alice' })).toBe(
      '42+alice@users.noreply.github.com',
    );
    expect(principalIdForUser(42)).toBe('github-42');
  });

  it('accepts GITQUIRE_HOST=github and a commit email format', () => {
    const names = hostNamesFromEnv({
      GITQUIRE_HOST: 'GitHub',
      GITQUIRE_COMMIT_EMAIL_FORMAT: '{id}+{login}@users.noreply.github.example.com',
    });
    expect(names.noreplyEmail({ id: 5, login: 'bob' })).toBe(
      '5+bob@users.noreply.github.example.com',
    );
  });

  it('refuses a format without {login} or that is not an address', () => {
    expect(() => hostNamesFromEnv({ GITQUIRE_COMMIT_EMAIL_FORMAT: '{id}@x.org' })).toThrow(
      HostConfigError,
    );
    expect(() => hostNamesFromEnv({ GITQUIRE_COMMIT_EMAIL_FORMAT: '{login}' })).toThrow(
      'GITQUIRE_COMMIT_EMAIL_FORMAT',
    );
  });

  it('refuses an unknown host and a host this version does not support', () => {
    expect(() => hostNamesFromEnv({ GITQUIRE_HOST: 'gitlab' })).toThrow('github or forgejo');
    expect(() => hostNamesFromEnv({ GITQUIRE_HOST: 'forgejo' })).toThrow(HostConfigError);
  });

  it('gives person ids the prefix of the configured host', () => {
    setHostNames({ ...gitHubNames(), idPrefix: 'other-' });
    expect(principalIdForUser(9)).toBe('other-9');
  });
});
