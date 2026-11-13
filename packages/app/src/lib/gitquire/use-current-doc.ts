import { useSyncExternalStore } from 'react';
import { docNameFromHash } from '@/lib/doc-hash';

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function snapshot(): string | null {
  return docNameFromHash(window.location.hash);
}

export function useCurrentDocName(): string | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
