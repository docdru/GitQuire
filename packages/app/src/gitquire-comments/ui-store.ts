import { useSyncExternalStore } from 'react';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import type { Anchor, Author } from './thread-ops';

export interface DiscussionUiState {
  docName: string | null;
  activeThreadId: string | null;
  revealThreadId: string | null;
  draft: { anchor: Anchor; from: number; to: number; body?: string } | null;
}

let state: DiscussionUiState = {
  docName: null,
  activeThreadId: null,
  revealThreadId: null,
  draft: null,
};
const listeners = new Set<() => void>();

function emit(next: DiscussionUiState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getDiscussionUi(): DiscussionUiState {
  return state;
}

export function subscribeDiscussionUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDiscussionUi(): DiscussionUiState {
  return useSyncExternalStore(subscribeDiscussionUi, getDiscussionUi, getDiscussionUi);
}

export function openThread(docName: string, activeThreadId: string): void {
  emit({ docName, activeThreadId, revealThreadId: null, draft: null });
}

export function openCommentsPane(): void {
  requestDocPanelTab('comments');
}

export function showThreadInPane(docName: string, activeThreadId: string): void {
  openThread(docName, activeThreadId);
  openCommentsPane();
}

export function revealDiscussion(docName: string, threadId: string): void {
  emit({
    docName,
    activeThreadId: threadId,
    revealThreadId: threadId,
    draft: null,
  });
}

export function clearReveal(): void {
  if (state.revealThreadId !== null) emit({ ...state, revealThreadId: null });
}

export function startDraft(docName: string, draft: NonNullable<DiscussionUiState['draft']>): void {
  emit({ docName, activeThreadId: null, revealThreadId: null, draft });
}

export function clearDraft(): void {
  emit({ ...state, draft: null });
}

export function setActiveThread(activeThreadId: string | null): void {
  emit({ ...state, activeThreadId, draft: activeThreadId === null ? state.draft : null });
}

interface MeResponse {
  principalId?: unknown;
  login?: unknown;
  name?: unknown;
}

interface PrincipalResponse {
  id?: unknown;
  display_name?: unknown;
}

let identity: Promise<Author> | undefined;

async function loadIdentity(): Promise<Author> {
  const me = await fetch('/auth/me', { credentials: 'same-origin' }).catch(() => undefined);
  if (me?.ok) {
    const body = (await me.json()) as MeResponse;
    if (typeof body.principalId === 'string' && typeof body.login === 'string') {
      return {
        id: body.principalId,
        login: body.login,
        name: typeof body.name === 'string' && body.name !== '' ? body.name : body.login,
      };
    }
  }
  const principal = await fetch('/api/principal', { credentials: 'same-origin' });
  const body = (await principal.json()) as PrincipalResponse;
  const id = typeof body.id === 'string' ? body.id : 'anonymous';
  const name = typeof body.display_name === 'string' ? body.display_name : id;
  return { id, name };
}

export function currentAuthor(): Promise<Author> {
  identity ??= loadIdentity().catch((err: unknown) => {
    identity = undefined;
    throw err;
  });
  return identity;
}
