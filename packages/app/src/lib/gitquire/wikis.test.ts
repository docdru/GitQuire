import { describe, expect, it } from 'vitest';
import { parseDoorWikis, unreadElsewhere } from './wikis';

describe("the front door's wiki list", () => {
  it('keeps only well-formed wikis with an address under /w/', () => {
    expect(
      parseDoorWikis({
        wikis: [
          { key: 'github-1', owner: 'team', name: 'a', address: '/w/github/team/a/', state: 'on' },
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
          hostKey: 'github',
          hostLabel: 'github',
          fullName: 'github/team/a',
          owner: 'team',
          name: 'a',
          address: '/w/github/team/a/',
          admin: false,
          state: 'on',
          why: null,
          unread: 0,
        },
      ],
      hosts: 'This server hosts wikis from team.',
      addWikiPage: '/add-wiki',
      severalHosts: false,
      signInWith: [],
    });
  });

  it('reads the host of each wiki and the hosts the person can still sign in with', () => {
    const door = parseDoorWikis({
      wikis: [
        {
          key: 'lab-1',
          hostKey: 'lab',
          hostLabel: 'Forgejo (lab)',
          fullName: 'lab/team/a',
          owner: 'team',
          name: 'a',
          address: '/w/lab/team/a/',
        },
      ],
      accounts: [],
      signInWith: [
        { host: 'github', label: 'GitHub', address: '/auth/github/login' },
        { host: 'evil', label: 'Evil', address: 'https://evil.example/' },
      ],
    });
    expect(door?.wikis[0]).toMatchObject({ hostLabel: 'Forgejo (lab)', fullName: 'lab/team/a' });
    expect(door?.severalHosts).toBe(true);
    expect(door?.signInWith).toEqual([
      { host: 'github', label: 'GitHub', address: '/auth/github/login' },
    ]);
  });

  it('counts unread mentions in the other wikis only', () => {
    const door = parseDoorWikis({
      wikis: [
        { key: 'github-1', owner: 'team', name: 'a', address: '/w/github/team/a/', unread: 3 },
        { key: 'github-2', owner: 'team', name: 'b', address: '/w/github/team/b/', unread: 2 },
        { key: 'github-3', owner: 'team', name: 'c', address: '/w/github/team/c/', unread: -4 },
      ],
    });
    expect(door?.wikis.map((wiki) => wiki.unread)).toEqual([3, 2, 0]);
    expect(unreadElsewhere(door, '/w/github/team/a/')).toBe(2);
    expect(unreadElsewhere(null, '/w/github/team/a/')).toBe(0);
  });

  it('is nothing for an answer without a list', () => {
    expect(parseDoorWikis({ error: 'not-signed-in' })).toBeNull();
    expect(parseDoorWikis(null)).toBeNull();
  });
});
