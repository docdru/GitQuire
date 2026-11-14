import { describe, expect, test } from 'vitest';
import {
  conflictCount,
  type DraftSummary,
  draftsTouching,
  fetchDrafts,
  resolveConflict,
  reviewState,
} from './drafts-api';

function draft(overrides: Partial<DraftSummary>): DraftSummary {
  return {
    slug: 'plan',
    title: 'Plan',
    status: 'draft',
    author: { id: 1, login: 'alice' },
    createdAt: '',
    updatedAt: '',
    base: 'main',
    pullUrl: null,
    reviews: [],
    requests: [],
    pages: [],
    agent: false,
    closedAt: null,
    closedBy: null,
    ...overrides,
  };
}

describe('drafts helpers', () => {
  test('finds open drafts that change a page', () => {
    const a = draft({ slug: 'a', pages: [{ path: 'notes/x.md', change: 'modified' }] });
    const b = draft({
      slug: 'b',
      status: 'published',
      pages: [{ path: 'notes/x.md', change: 'modified' }],
    });
    expect(draftsTouching([a, b], 'notes/x.md').map((d) => d.slug)).toEqual(['a']);
    expect(draftsTouching([a, b], null)).toEqual([]);
  });

  test('summarises reviews, a request for changes wins', () => {
    const approved = { login: 'b', verdict: 'approved' as const, note: '', at: '' };
    const changes = { login: 'c', verdict: 'changes' as const, note: '', at: '' };
    expect(reviewState(draft({}))).toBe('none');
    expect(reviewState(draft({ reviews: [approved] }))).toBe('approved');
    expect(reviewState(draft({ reviews: [approved, changes] }))).toBe('changes');
  });

  test('builds the resolved page from the chosen texts', () => {
    const file = {
      path: 'a.md',
      chunks: [
        { kind: 'same' as const, text: 'top\n' },
        { kind: 'conflict' as const, draft: 'mine\n', live: 'theirs\n', base: 'old\n' },
        { kind: 'same' as const, text: 'middle\n' },
        { kind: 'conflict' as const, draft: 'x\n', live: 'y\n', base: '' },
      ],
    };
    expect(conflictCount(file)).toBe(2);
    expect(resolveConflict(file, ['theirs\n', undefined])).toBe('top\ntheirs\nmiddle\nx\n');
  });

  test('treats a server without drafts as disabled', async () => {
    const notFound = (async () =>
      new Response(JSON.stringify({ error: 'not-found' }), { status: 404 })) as typeof fetch;
    await expect(fetchDrafts({ fetch: notFound })).resolves.toMatchObject({ enabled: false });
  });
});
