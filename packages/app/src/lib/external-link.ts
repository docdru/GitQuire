import { isSafeNavigationUrl } from '@/editor/safe-navigation-url';

interface OpenExternalUrlDeps {
  readonly openWindow?: (url: string, target: string, features: string) => unknown;
}

export function openExternalUrl(url: string, deps: OpenExternalUrlDeps = {}): void {
  if (!isSafeNavigationUrl(url)) {
    console.warn('[external-link] blocked non-safe scheme', url);
    return;
  }
  const globalOpen = typeof window !== 'undefined' ? window.open.bind(window) : undefined;
  const openWindow = deps.openWindow ?? globalOpen;
  openWindow?.(url, '_blank', 'noopener,noreferrer');
}
