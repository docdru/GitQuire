import { afterEach, describe, expect, it } from 'vitest';
import { principalIdForUser } from '../principal-directory.ts';
import {
  callbackPath,
  gitHubNames,
  HostConfigError,
  hostNames,
  hostNamesFromEnv,
  resetHostNames,
  setHostNames,
  signInPath,
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

  it('refuses an unknown host, and Forgejo without its address', () => {
    expect(() => hostNamesFromEnv({ GITQUIRE_HOST: 'gitlab' })).toThrow('github or forgejo');
    expect(() => hostNamesFromEnv({ GITQUIRE_HOST: 'forgejo' })).toThrow(HostConfigError);
  });

  it('names Forgejo people and their no-reply email after the server', () => {
    const names = hostNamesFromEnv({
      GITQUIRE_HOST: 'forgejo',
      GITQUIRE_HOST_URL: 'https://git.example.org/forgejo/',
    });
    expect(names.kind).toBe('forgejo');
    expect(names.label).toBe('Forgejo');
    expect(names.idPrefix).toBe('forgejo-');
    expect(names.noreplyEmail({ id: 3, login: 'bob' })).toBe('bob@noreply.git.example.org');
    setHostNames(names);
    expect(principalIdForUser(3)).toBe('forgejo-3');
    expect(signInPath()).toBe('/auth/forgejo/login');
    expect(callbackPath()).toBe('/auth/forgejo/callback');
    const custom = hostNamesFromEnv({
      GITQUIRE_HOST: 'forgejo',
      GITQUIRE_HOST_URL: 'https://git.example.org',
      GITQUIRE_COMMIT_EMAIL_FORMAT: '{login}@users.example.org',
    });
    expect(custom.noreplyEmail({ id: 3, login: 'bob' })).toBe('bob@users.example.org');
  });

  it('keeps the GitHub sign-in paths', () => {
    expect(signInPath()).toBe('/auth/github/login');
    expect(callbackPath()).toBe('/auth/github/callback');
  });

  it('gives person ids the prefix of the configured host', () => {
    setHostNames({ ...gitHubNames(), idPrefix: 'other-' });
    expect(principalIdForUser(9)).toBe('other-9');
  });
});
