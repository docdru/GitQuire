import { useSyncExternalStore } from 'react';
import type { DraftReview, DraftSummary, FileConflict } from '@/lib/gitquire/drafts-api';

export type DraftDialog =
  | { kind: 'new'; title: string }
  | { kind: 'move'; path: string; title: string }
  | { kind: 'ready'; draft: DraftSummary }
  | { kind: 'review'; draft: DraftSummary; verdict: DraftReview['verdict'] }
  | { kind: 'publish'; draft: DraftSummary }
  | { kind: 'discard'; draft: DraftSummary }
  | { kind: 'rename'; draft: DraftSummary }
  | { kind: 'changes'; draft: DraftSummary }
  | { kind: 'conflicts'; draft: DraftSummary; files: FileConflict[] }
  | { kind: 'overview' };

let current: DraftDialog | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openDraftDialog(dialog: DraftDialog): void {
  current = dialog;
  emit();
}

export function closeDraftDialog(): void {
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDraftDialog(): DraftDialog | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
