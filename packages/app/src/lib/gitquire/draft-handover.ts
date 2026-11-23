import { t } from '@lingui/core/macro';
import { useSyncExternalStore } from 'react';
import { type ClosedDraft, type CurrentDraft, fetchCurrentDraft, openView } from './drafts-api';
import { draftSnapshot, reloadIntoView } from './drafts-store';

export type HandoverState = 'none' | 'checking' | 'planned';
export type ArrivingView = 'draft' | 'live';

const NOTICE_KEY = 'gitquire:draft-notice';
const ARRIVING_KEY = 'gitquire:arriving-view';
const ARRIVING_MAX_MS = 60_000;
const CHECK_TIMEOUT_MS = 3_000;
const CLOSING_POLL_MS = 1_000;
const CLOSING_MAX_POLLS = 120;

function takeArriving(): ArrivingView | null {
  try {
    const raw = window.sessionStorage.getItem(ARRIVING_KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(ARRIVING_KEY);
    const [view, at] = raw.split(':');
    if (view !== 'draft' && view !== 'live') return null;
    return Date.now() - Number(at) < ARRIVING_MAX_MS ? view : null;
  } catch {
    return null;
  }
}

let arriving: ArrivingView | null = typeof window === 'undefined' ? null : takeArriving();
let state: HandoverState = arriving === null ? 'none' : 'planned';
let checkedThisOutage = false;
let leaving = false;
const listeners = new Set<() => void>();

if (arriving !== null) {
  setTimeout(() => {
    if (arriving !== null) noteSynced();
  }, ARRIVING_MAX_MS);
}

function set(next: HandoverState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function handoverState(): HandoverState {
  return state;
}

export function useDraftHandover(): HandoverState {
  return useSyncExternalStore(subscribe, handoverState, () => 'none');
}

export function arrivingView(): ArrivingView | null {
  return arriving;
}

export function useArrivingView(): ArrivingView | null {
  return useSyncExternalStore(subscribe, arrivingView, () => null);
}

export function noteSynced(): void {
  if (arriving === null) return;
  arriving = null;
  if (!leaving) state = 'none';
  for (const listener of listeners) listener();
}

export function reloadInto(view: ArrivingView): void {
  leaving = true;
  set('planned');
  try {
    window.sessionStorage.setItem(ARRIVING_KEY, `${view}:${Date.now()}`);
  } catch {}
  reloadIntoView();
}

export function beginHandover(): void {
  set('planned');
}

export function endHandover(): void {
  if (leaving) return;
  set('none');
}

function storeNotice(notice: string): void {
  try {
    window.sessionStorage.setItem(NOTICE_KEY, notice);
  } catch {}
}

export function takeLeaveNotice(): string | null {
  try {
    const notice = window.sessionStorage.getItem(NOTICE_KEY);
    if (notice !== null) window.sessionStorage.removeItem(NOTICE_KEY);
    return notice;
  } catch {
    return null;
  }
}

export function leaveDraft(notice?: string, to: ArrivingView = 'live'): void {
  if (notice !== undefined) storeNotice(notice);
  reloadInto(to);
}

export function closedNotice(closed: ClosedDraft): string {
  const who = closed.closedBy?.name ?? closed.closedBy?.login;
  if (closed.status === 'published') {
    return who === undefined
      ? t`"${closed.title}" was published. You are now on the live wiki.`
      : t`${who} published "${closed.title}". You are now on the live wiki.`;
  }
  return who === undefined
    ? t`"${closed.title}" was discarded. You are now on the live wiki.`
    : t`${who} discarded "${closed.title}". You are now on the live wiki.`;
}

export async function leaveClosedDraft(closed: ClosedDraft): Promise<void> {
  if (leaving) return;
  leaving = true;
  set('planned');
  await openView(null).catch(() => undefined);
  leaveDraft(closedNotice(closed));
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function askServer(): Promise<CurrentDraft | null> {
  return withTimeout(fetchCurrentDraft(), CHECK_TIMEOUT_MS).catch(() => null);
}

async function checkDraft(): Promise<void> {
  let current = await askServer();
  if (current?.closing === true && state === 'checking') set('planned');
  for (let poll = 0; current?.closing === true && poll < CLOSING_MAX_POLLS; poll += 1) {
    await wait(CLOSING_POLL_MS);
    current = await askServer();
  }
  if (current?.closed) {
    await leaveClosedDraft(current.closed);
    return;
  }
  if (leaving) return;
  checkedThisOutage = true;
  set('none');
}

export function noteDisconnected(): boolean {
  if (state !== 'none') return true;
  if (checkedThisOutage) return false;
  if (draftSnapshot().current?.viewing == null) return false;
  set('checking');
  void checkDraft();
  return true;
}

export function noteConnected(): void {
  checkedThisOutage = false;
}
