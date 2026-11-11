import { useSyncExternalStore } from 'react';
import type { Anchor, Author } from './thread-ops';

export interface DiscussionUiState {
  docName: string | null;
  open: boolean;
  activeThreadId: string | null;
  revealThreadId: string | null;
  draft: { anchor: Anchor; from: number; to: number } | null;
}

let state: DiscussionUiState = {
  docName: null,
  open: false,
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

export function openDiscussions(docName: string, activeThreadId: string | null = null): void {
  const draft = state.docName === docName ? state.draft : null;
  emit({ docName, open: true, activeThreadId, revealThreadId: null, draft });
}

export function revealDiscussion(docName: string, threadId: string): void {
  const draft = state.docName === docName ? state.draft : null;
  emit({ docName, open: true, activeThreadId: threadId, revealThreadId: threadId, draft });
}

export function clearReveal(): void {
  if (state.revealThreadId !== null) emit({ ...state, revealThreadId: null });
}

export function closeDiscussions(): void {
  emit({
    docName: state.docName,
    open: false,
    activeThreadId: null,
    revealThreadId: null,
    draft: null,
  });
}

export function startDraft(docName: string, draft: NonNullable<DiscussionUiState['draft']>): void {
  emit({ docName, open: true, activeThreadId: null, revealThreadId: null, draft });
}

export function clearDraft(): void {
  emit({ ...state, draft: null });
}

export function setActiveThread(activeThreadId: string | null): void {
  emit({ ...state, activeThreadId });
}

interface MeResponse {
  id?: unknown;
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
    if (typeof body.id === 'number' && typeof body.login === 'string') {
      return {
        id: `github-${body.id}`,
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
