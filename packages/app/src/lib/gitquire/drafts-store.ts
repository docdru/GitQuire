import { useSyncExternalStore } from 'react';
import {
  type ClosedDraft,
  type CurrentDraft,
  type DraftList,
  fetchCurrentDraft,
  fetchDrafts,
} from './drafts-api';

export interface DraftState {
  loaded: boolean;
  list: DraftList | null;
  current: CurrentDraft | null;
}

const POLL_MS = 30_000;
const POLL_IN_DRAFT_MS = 10_000;
const EMPTY: DraftState = { loaded: false, list: null, current: null };

let state: DraftState = EMPTY;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | undefined;
let focusHooked = false;
const listeners = new Set<() => void>();
const closedListeners = new Set<(closed: ClosedDraft) => void>();

function emit(next: DraftState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function refreshDrafts(): Promise<void> {
  if (inFlight !== undefined) return inFlight;
  inFlight = (async () => {
    try {
      const list = await fetchDrafts();
      const current = list.enabled ? await fetchCurrentDraft() : null;
      emit({ loaded: true, list, current });
      if (current?.closed) for (const listener of closedListeners) listener(current.closed);
    } catch {
      emit({ ...state, loaded: true });
    } finally {
      inFlight = undefined;
    }
  })();
  return inFlight;
}

function pollEvery(): number {
  return state.current?.viewing ? POLL_IN_DRAFT_MS : POLL_MS;
}

function schedule(): void {
  timer = setTimeout(() => {
    void refreshDrafts().finally(() => {
      if (timer !== undefined) schedule();
    });
  }, pollEvery());
}

function start(): void {
  if (timer !== undefined) return;
  void refreshDrafts();
  schedule();
  if (!focusHooked && typeof window !== 'undefined') {
    focusHooked = true;
    window.addEventListener('focus', () => void refreshDrafts());
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

function snapshot(): DraftState {
  return state;
}

export function useDraftState(): DraftState {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

export function onDraftClosed(listener: (closed: ClosedDraft) => void): () => void {
  closedListeners.add(listener);
  return () => closedListeners.delete(listener);
}

export function reloadIntoView(): void {
  if (typeof window !== 'undefined') window.location.reload();
}
