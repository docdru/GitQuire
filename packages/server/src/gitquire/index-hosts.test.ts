import { afterEach, describe, expect, it } from 'vitest';
import { resetHostNames } from './host/names.ts';
import { configureHostFromEnv } from './index.ts';

afterEach(() => resetHostNames());

describe('a single wiki and the host list', () => {
  it('refuses GITQUIRE_HOSTS, which only the front door reads', () => {
    expect(() => configureHostFromEnv({ GITQUIRE_HOSTS: 'forgejo' }, undefined)).toThrow(
      /adds Git hosts to the front door/,
    );
  });

  it('starts as before without it', () => {
    expect(configureHostFromEnv({ GITQUIRE_HOSTS: ' , ' }, undefined).kind).toBe('github');
  });
});
