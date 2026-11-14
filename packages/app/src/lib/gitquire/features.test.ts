import { describe, expect, it } from 'vitest';
import { fetchFeatures, hasClaudeAccess, parseFeatures, STANDALONE_FEATURES } from './features';

function respond(status: number, body: string, type = 'application/json'): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { 'content-type': type } })) as typeof fetch;
}

describe('GitQuire features', () => {
  it('reads who may change wiki settings', () => {
    const member = parseFeatures({
      admin: false,
      admins: { logins: ['bob', 7], repo: 'acme/notes' },
      features: {},
    });
    expect(member).toMatchObject({
      settingsAdmin: false,
      adminLogins: ['bob'],
      adminRepo: 'acme/notes',
    });
    expect(parseFeatures({ admin: true, features: {} }).settingsAdmin).toBe(true);
    expect(STANDALONE_FEATURES.settingsAdmin).toBe(true);
  });

  it('ignores the retired askAi flag from an older server', async () => {
    const features = await fetchFeatures(
      respond(200, JSON.stringify({ login: 'alice', features: { askAi: true } })),
    );
    expect(features).not.toHaveProperty('askAi');
    expect(features.agentToken).toBe(false);
  });

  it('reads which kinds of agent access the person has', async () => {
    const features = await fetchFeatures(
      respond(
        200,
        JSON.stringify({
          features: {
            aiChat: true,
            agentToken: true,
            connector: false,
            canUseTokens: true,
            canConnect: true,
          },
        }),
      ),
    );
    expect(features).toEqual({
      aiChat: true,
      agentToken: true,
      connector: false,
      canUseTokens: true,
      canConnect: true,
      settingsAdmin: false,
      adminLogins: [],
      adminRepo: null,
    });
    expect(hasClaudeAccess(features)).toBe(true);
    expect(hasClaudeAccess(STANDALONE_FEATURES)).toBe(false);
  });

  it('keeps the upstream behaviour without GitHub sign-in', async () => {
    expect(await fetchFeatures(respond(200, '<!doctype html>', 'text/html'))).toEqual(
      STANDALONE_FEATURES,
    );
    expect(await fetchFeatures(respond(404, '{}'))).toEqual(STANDALONE_FEATURES);
    expect(
      await fetchFeatures((async () => {
        throw new Error('offline');
      }) as typeof fetch),
    ).toEqual(STANDALONE_FEATURES);
    expect(parseFeatures({ login: 'alice' })).toEqual(STANDALONE_FEATURES);
  });
});
