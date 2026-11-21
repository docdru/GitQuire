import { describe, expect, it } from 'vitest';
import { repoChange } from './renames.ts';
import type { HostRepoRecord } from './types.ts';

const stored: HostRepoRecord = { host: 'forgejo', id: 1, owner: 'team', ownerId: 7, name: 'wiki' };

function found(repo: Partial<HostRepoRecord>) {
  return { state: 'found' as const, repo: { ...stored, ...repo } };
}

describe('repoChange', () => {
  it('says same, renamed or moved', () => {
    expect(repoChange(stored, found({}))).toEqual({ change: 'same' });
    expect(repoChange(stored, found({ name: 'handbook' }))).toEqual({
      change: 'renamed',
      to: { owner: 'team', name: 'handbook' },
    });
    expect(repoChange(stored, found({ owner: 'crew' }))).toEqual({
      change: 'renamed',
      to: { owner: 'crew', name: 'wiki' },
    });
    expect(repoChange(stored, found({ name: 'Wiki' }))).toEqual({
      change: 'renamed',
      to: { owner: 'team', name: 'Wiki' },
    });
    expect(repoChange(stored, found({ owner: 'other', ownerId: 9 }))).toEqual({
      change: 'moved',
      to: { owner: 'other', name: 'wiki' },
      ownerId: 9,
    });
  });

  it('passes on gone, refused and unreachable, and refuses another repo', () => {
    expect(repoChange(stored, { state: 'gone' })).toEqual({ change: 'gone' });
    expect(repoChange(stored, { state: 'unreachable' })).toEqual({ change: 'unreachable' });
    expect(repoChange(stored, { state: 'refused', refusal: 'token' })).toEqual({
      change: 'refused',
      refusal: 'token',
    });
    expect(repoChange(stored, found({ id: 2 }))).toEqual({ change: 'mismatch' });
    expect(repoChange(stored, found({ host: 'github' }))).toEqual({ change: 'mismatch' });
  });
});
