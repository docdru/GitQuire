import { describe, expect, it } from 'vitest';
import {
  type AllowedOwners,
  allowedOwnersSentence,
  ownerAllowed,
  pinAllowedOwner,
} from './allowed-owners.ts';

function owners(names: string[], pinned: Record<string, number> = {}): AllowedOwners {
  return {
    names: new Set(names),
    pinned: () => pinned,
    pin: (name, id) => {
      pinned[name] = id;
    },
  };
}

describe('allowed owners', () => {
  it('matches a listed name until an id is pinned for it', () => {
    const list = owners(['team']);
    expect(ownerAllowed(list, { owner: 'Team', ownerId: 7 })).toBe(true);
    expect(ownerAllowed(list, { owner: 'other', ownerId: 8 })).toBe(false);
  });

  it('compares by the pinned owner id: a renamed owner stays allowed, a new owner of the old name does not', () => {
    const list = owners(['team']);
    pinAllowedOwner(list, { owner: 'team', ownerId: 7 });
    expect(list.pinned()).toEqual({ team: 7 });
    expect(ownerAllowed(list, { owner: 'team-renamed', ownerId: 7 })).toBe(true);
    expect(ownerAllowed(list, { owner: 'team', ownerId: 99 })).toBe(false);
  });

  it('says which owners the server hosts', () => {
    expect(allowedOwnersSentence(owners(['team', 'docs']))).toBe(
      'This server hosts wikis from docs, team.',
    );
  });
});
