import { describe, expect, it } from 'vitest';
import type { GitHubDraftsClient } from '../github-pulls.ts';
import type { DraftRecord } from './model.ts';
import { gitHubRemote } from './remote.ts';

const draft: DraftRecord = {
  slug: 'notes',
  branch: 'gitquire/draft/notes',
  title: 'Notes',
  base: 'main',
  baseSha: 'abc',
  author: { id: 1, login: 'alice', name: 'Alice' },
  createdAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z',
  status: 'review',
  pull: 7,
  reviews: [],
  requests: [],
};

const client = {} as GitHubDraftsClient;

describe('gitHubRemote pullUrl', () => {
  it('links to the configured GitHub web address', () => {
    const remote = gitHubRemote(
      client,
      { owner: 'acme', name: 'notes' },
      'https://github.example.com',
    );
    expect(remote.pullUrl(draft)).toBe('https://github.example.com/acme/notes/pull/7');
  });

  it('has no link before a pull request exists', () => {
    const remote = gitHubRemote(client, { owner: 'acme', name: 'notes' }, 'https://github.com');
    expect(remote.pullUrl({ ...draft, pull: undefined })).toBeUndefined();
  });
});
