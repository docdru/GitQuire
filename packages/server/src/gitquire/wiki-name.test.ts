import { describe, expect, it } from 'vitest';
import { wikiNameFromEnv } from './wiki-name.ts';

describe('the wiki name in mails and chat messages', () => {
  it('carries the host behind the front door', () => {
    expect(
      wikiNameFromEnv({
        GITQUIRE_BEHIND_FRONT_DOOR: 'on',
        GITQUIRE_REPO: 'team/a',
        GITQUIRE_WIKI_NAME: 'forgejo/team/a',
      }),
    ).toBe('forgejo/team/a');
  });

  it('falls back to owner/repo, and is not used for a single wiki', () => {
    expect(wikiNameFromEnv({ GITQUIRE_BEHIND_FRONT_DOOR: 'on', GITQUIRE_REPO: 'team/a' })).toBe(
      'team/a',
    );
    expect(
      wikiNameFromEnv({ GITQUIRE_BEHIND_FRONT_DOOR: 'on', GITQUIRE_WIKI_NAME: 'x/../y' }),
    ).toBeUndefined();
    expect(wikiNameFromEnv({ GITQUIRE_REPO: 'team/a', GITQUIRE_WIKI_NAME: 'github/team/a' })).toBe(
      undefined,
    );
  });
});
