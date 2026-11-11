import { useSyncExternalStore } from 'react';

export const COMPACT_VIEWPORT_QUERY = '(max-width: 639px), (max-height: 499px)';

function query(): MediaQueryList | null {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(COMPACT_VIEWPORT_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

function snapshot(): boolean {
  return query()?.matches ?? false;
}

export function useCompactViewport(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
