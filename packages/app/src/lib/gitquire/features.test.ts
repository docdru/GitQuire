import { describe, expect, it } from 'vitest';
import { fetchFeatures, hasClaudeAccess, parseFeatures, STANDALONE_FEATURES } from './features';

function respond(status: number, body: string, type = 'application/json'): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { 'content-type': type } })) as typeof fetch;
}

describe('GitQuire features', () => {
  it('hides Ask AI when the server says so', async () => {
    const features = await fetchFeatures(
      respond(200, JSON.stringify({ login: 'alice', features: { askAi: false } })),
    );
    expect(features.askAi).toBe(false);
    expect(features.agentToken).toBe(false);
  });

  it('reads which kinds of agent access the person has', async () => {
    const features = await fetchFeatures(
      respond(
        200,
        JSON.stringify({ features: { askAi: false, agentToken: true, connector: false } }),
      ),
    );
    expect(features).toEqual({ askAi: false, agentToken: true, connector: false });
    expect(hasClaudeAccess(features)).toBe(true);
    expect(hasClaudeAccess(STANDALONE_FEATURES)).toBe(false);
  });

  it('keeps Ask AI when the server turns it on', async () => {
    const features = await fetchFeatures(
      respond(200, JSON.stringify({ login: 'alice', features: { askAi: true } })),
    );
    expect(features.askAi).toBe(true);
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
