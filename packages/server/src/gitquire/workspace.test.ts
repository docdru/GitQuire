import { describe, expect, it } from 'vitest';
import type { RunGit } from './repo-bootstrap.ts';
import { describeWorkspace, resolveWorkspace } from './workspace.ts';

const onBranch =
  (branch: string): RunGit =>
  () =>
    `${branch}\n`;
const detached: RunGit = () => {
  throw new Error('not a symbolic ref');
};

describe('workspace', () => {
  it('is the live wiki on the checked-out branch outside a draft', () => {
    const workspace = resolveWorkspace({}, '/wiki', onBranch('main'));
    expect(workspace).toEqual({ kind: 'live', branch: 'main', draft: null });
    expect(describeWorkspace(workspace)).toBe(
      'You are working in the live wiki (branch main). Changes you make here are saved for everyone right away.',
    );
  });

  it('names the draft, its branch and where it started', () => {
    const workspace = resolveWorkspace(
      {
        GITQUIRE_DRAFT: 'pricing-page',
        GITQUIRE_DRAFT_TITLE: 'Pricing page',
        GITQUIRE_DRAFT_BASE: 'main',
      },
      '/drafts/pricing-page',
      onBranch('draft/pricing-page'),
    );
    expect(workspace).toEqual({
      kind: 'draft',
      branch: 'draft/pricing-page',
      draft: { slug: 'pricing-page', title: 'Pricing page', base: 'main' },
    });
    expect(describeWorkspace(workspace)).toBe(
      'You are working in the draft "Pricing page" (branch draft/pricing-page, started from main), not in the live wiki. Changes you make stay in this draft until someone publishes it.',
    );
  });

  it('falls back to the configured branch and the slug when git and the title are missing', () => {
    const workspace = resolveWorkspace(
      { GITQUIRE_DRAFT: 'pricing-page', GITQUIRE_BRANCH: 'draft/pricing-page' },
      '/drafts/pricing-page',
      detached,
    );
    expect(workspace.branch).toBe('draft/pricing-page');
    expect(workspace.draft).toEqual({ slug: 'pricing-page', title: 'pricing-page', base: null });
  });

  it('says so when no branch is checked out', () => {
    expect(describeWorkspace(resolveWorkspace({}, '/wiki', detached))).toContain(
      'no branch checked out',
    );
  });
});
