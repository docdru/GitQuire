import { describe, expect, it } from 'vitest';
import { parseDoorWikis } from './wikis';

describe("the front door's wiki list", () => {
  it('keeps only well-formed wikis with an address under /w/', () => {
    expect(
      parseDoorWikis({
        wikis: [
          { key: 'github-1', owner: 'team', name: 'a', address: '/w/team/a/', state: 'on' },
          { key: 'github-2', owner: 'team', name: 'b', address: 'https://evil.example/' },
          { key: 'github-3', owner: 'team' },
        ],
        hosts: 'This server hosts wikis from team.',
        addWikiPage: '//evil.example',
      }),
    ).toEqual({
      wikis: [
        {
          key: 'github-1',
          owner: 'team',
          name: 'a',
          address: '/w/team/a/',
          admin: false,
          state: 'on',
          why: null,
        },
      ],
      hosts: 'This server hosts wikis from team.',
      addWikiPage: '/add-wiki',
    });
  });

  it('is nothing for an answer without a list', () => {
    expect(parseDoorWikis({ error: 'not-signed-in' })).toBeNull();
    expect(parseDoorWikis(null)).toBeNull();
  });
});
