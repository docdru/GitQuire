import { useLingui } from '@lingui/react/macro';
import { type RefObject, useEffect } from 'react';
import { applyDraftBadges, draftChangeIndex } from '@/lib/gitquire/draft-tree-badges';
import { useDraftState } from '@/lib/gitquire/drafts-store';

export function useDraftTreeBadges(
  hostRef: RefObject<HTMLElement | null>,
  tagName: string,
  ready: boolean,
): void {
  const { t } = useLingui();
  const { current } = useDraftState();
  const pages = current?.viewing?.pages;
  const changes = draftChangeIndex(pages ?? []);

  useEffect(() => {
    if (!ready) return;
    const shadow = hostRef.current?.querySelector(tagName)?.shadowRoot;
    if (!shadow) return;
    const label = (change: 'added' | 'modified' | 'deleted') =>
      change === 'added'
        ? t`New in this draft`
        : change === 'deleted'
          ? t`Deleted in this draft`
          : t`Changed in this draft`;
    const apply = () => applyDraftBadges(shadow, changes, label);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(shadow, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-item-path'],
    });
    return () => observer.disconnect();
  }, [ready, hostRef, tagName, changes, t]);
}
