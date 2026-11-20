import type { Editor } from '@tiptap/react';
import { useSyncExternalStore } from 'react';

const editors = new Map<string, Editor>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function registerCommentEditor(docName: string, editor: Editor): () => void {
  editors.set(docName, editor);
  notify();
  return () => {
    if (editors.get(docName) !== editor) return;
    editors.delete(docName);
    notify();
  };
}

export function getCommentEditor(docName: string): Editor | null {
  return editors.get(docName) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCommentEditor(docName: string): Editor | null {
  return useSyncExternalStore(
    subscribe,
    () => getCommentEditor(docName),
    () => null,
  );
}
