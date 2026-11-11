import { useSyncExternalStore } from 'react';

const COARSE_POINTER_QUERY = '(pointer: coarse)';

function coarseList(): MediaQueryList | null {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(COARSE_POINTER_QUERY);
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = coarseList();
      list?.addEventListener('change', onChange);
      return () => list?.removeEventListener('change', onChange);
    },
    () => coarseList()?.matches ?? false,
    () => false,
  );
}

export function keyboardInset(
  layoutHeight: number,
  viewport: { height: number; offsetTop: number } | null,
): number {
  if (viewport === null) return 0;
  return Math.max(0, Math.round(layoutHeight - (viewport.height + viewport.offsetTop)));
}

function currentInset(): number {
  if (typeof window === 'undefined') return 0;
  return keyboardInset(window.innerHeight, window.visualViewport ?? null);
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(
    (onChange) => {
      const viewport = typeof window === 'undefined' ? null : window.visualViewport;
      viewport?.addEventListener('resize', onChange);
      viewport?.addEventListener('scroll', onChange);
      return () => {
        viewport?.removeEventListener('resize', onChange);
        viewport?.removeEventListener('scroll', onChange);
      };
    },
    currentInset,
    () => 0,
  );
}
