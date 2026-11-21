import { describe, expect, it } from 'vitest';
import type { DoorHost } from '../host/types.ts';
import { addWikiHelpFor, githubAppInstallUrl } from './add-wiki-help.ts';

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('Add a wiki help', () => {
  it("builds the GitHub App's install page from GET /app with the app's JWT", async () => {
    const seen: string[] = [];
    const url = await githubAppInstallUrl(
      'https://api.github.com',
      () => 'jwt-1',
      async (target, init) => {
        seen.push(`${target} ${new Headers(init.headers).get('authorization')}`);
        return answer(200, { html_url: 'https://github.com/apps/team-wiki' });
      },
    );
    expect(url).toBe('https://github.com/apps/team-wiki/installations/new');
    expect(seen).toEqual(['https://api.github.com/app Bearer jwt-1']);
    expect(
      await githubAppInstallUrl(
        'https://api.github.com',
        () => 'jwt',
        async () => answer(401, {}),
      ),
    ).toBeUndefined();
  });

  it('names the Forgejo bot from its own token and asks again only until it is found', async () => {
    let calls = 0;
    const host = {
      person: async (token: string) => {
        calls += 1;
        return token === 'bot' && calls > 1
          ? { id: 1, login: 'gq-bot', name: 'Bot', avatarUrl: '' }
          : undefined;
      },
    } as unknown as DoorHost;
    const help = addWikiHelpFor({
      host,
      kind: 'forgejo',
      apiUrl: 'https://forgejo.example/api/v1',
      jwt: () => '',
      botToken: () => 'bot',
    });
    expect(await help()).toEqual({});
    expect(await help()).toEqual({ botLogin: 'gq-bot' });
    expect(await help()).toEqual({ botLogin: 'gq-bot' });
    expect(calls).toBe(2);
  });
});
