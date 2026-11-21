import { describe, expect, it } from 'vitest';
import { resolveDoorSyncConfig } from './door-token.ts';

describe('token from the front door', () => {
  it('is used only behind the front door with a token socket and a repository', () => {
    expect(
      resolveDoorSyncConfig({ GITQUIRE_REPO: 'team/wiki', GITQUIRE_DOOR_TOKEN_SOCKET: '/s' }),
    ).toBeUndefined();
    expect(
      resolveDoorSyncConfig({ GITQUIRE_BEHIND_FRONT_DOOR: 'on', GITQUIRE_REPO: 'team/wiki' }),
    ).toBeUndefined();
    expect(
      resolveDoorSyncConfig({
        GITQUIRE_BEHIND_FRONT_DOOR: 'on',
        GITQUIRE_REPO: 'team/wiki',
        GITQUIRE_DOOR_TOKEN_SOCKET: '/s',
      }),
    ).toEqual({
      host: 'github',
      repo: { owner: 'team', name: 'wiki' },
      branch: undefined,
      webUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      gitHost: 'github.com',
      socket: '/s',
    });
  });

  it('reads the Forgejo addresses', () => {
    expect(
      resolveDoorSyncConfig({
        GITQUIRE_BEHIND_FRONT_DOOR: 'on',
        GITQUIRE_HOST: 'forgejo',
        GITQUIRE_HOST_URL: 'https://code.example.org/',
        GITQUIRE_REPO: 'team/wiki',
        GITQUIRE_DOOR_TOKEN_SOCKET: '/s',
      }),
    ).toMatchObject({
      host: 'forgejo',
      webUrl: 'https://code.example.org',
      apiUrl: 'https://code.example.org/api/v1',
      gitHost: 'code.example.org',
    });
  });
});
