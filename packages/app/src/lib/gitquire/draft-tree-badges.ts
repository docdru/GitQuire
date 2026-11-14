import type { ChangedPage } from './drafts-api';

export const DRAFT_BADGE_ATTR = 'data-gq-draft-change';

export const FILE_TREE_DRAFT_BADGE_CSS = `
  [${DRAFT_BADGE_ATTR}] {
    display: inline-block;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 9999px;
    margin-inline: 0.375rem 0.25rem;
    align-self: center;
    flex-shrink: 0;
    pointer-events: none;
    background: var(--gq-draft-accent, #d97706);
  }
  [${DRAFT_BADGE_ATTR}='added'] {
    background: var(--gq-draft-added, #16a34a);
  }
  [${DRAFT_BADGE_ATTR}='deleted'] {
    background: var(--gq-draft-removed, #dc2626);
  }
`;

export function draftChangeIndex(
  pages: readonly ChangedPage[],
): Map<string, ChangedPage['change']> {
  return new Map(pages.map((page) => [page.path, page.change]));
}

export function applyDraftBadges(
  root: ParentNode,
  changes: ReadonlyMap<string, ChangedPage['change']>,
  label: (change: ChangedPage['change']) => string,
): void {
  const rows = root.querySelectorAll<HTMLElement>('[data-type="item"][data-item-path]');
  for (const row of rows) {
    const path = row.dataset.itemPath ?? '';
    const change = path.endsWith('/') ? undefined : changes.get(path);
    const existing = row.querySelector<HTMLElement>(`[${DRAFT_BADGE_ATTR}]`);
    if (change === undefined) {
      existing?.remove();
      continue;
    }
    if (existing?.getAttribute(DRAFT_BADGE_ATTR) === change) continue;
    existing?.remove();
    const badge = row.ownerDocument.createElement('span');
    badge.setAttribute(DRAFT_BADGE_ATTR, change);
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', label(change));
    badge.title = label(change);
    const actionSection = row.querySelector('[data-item-section="action"]');
    if (actionSection) actionSection.before(badge);
    else row.append(badge);
  }
}
