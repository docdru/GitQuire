import type { Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { useEffect } from 'react';
import { countTrailers, readThreads, writeThreads } from './editor-threads';
import { notePendingWrite, type PendingWrite, reconcileThreads } from './thread-merge';
import type { Thread } from './thread-ops';

const Y_SYNC_META_KEY = 'y-sync$';

const pendingWrites = new WeakMap<Editor, PendingWrite>();

export function isRemoteChange(transaction: Transaction): boolean {
  const meta = transaction.getMeta(Y_SYNC_META_KEY) as { isChangeOrigin?: boolean } | undefined;
  return transaction.docChanged && meta?.isChangeOrigin === true;
}

export function writeAndTrack(editor: Editor, threads: readonly Thread[]): boolean {
  if (editor.isDestroyed) return false;
  const base = readThreads(editor.state.doc);
  const tr = writeThreads(editor.state, threads);
  if (tr === undefined) return false;
  pendingWrites.set(editor, notePendingWrite(pendingWrites.get(editor), base, threads, Date.now()));
  editor.view.dispatch(tr);
  return true;
}

function reconcileEditor(editor: Editor): void {
  const doc = editor.state.doc;
  const theirs = readThreads(doc);
  const result = reconcileThreads(pendingWrites.get(editor), theirs, Date.now());
  if (result.pending === undefined) pendingWrites.delete(editor);
  const target = result.write ?? (countTrailers(doc) > 1 ? theirs : undefined);
  if (target === undefined) return;
  const tr = writeThreads(editor.state, target);
  if (tr === undefined) return;
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

export function useThreadSync(editor: Editor): void {
  useEffect(() => {
    let queued = false;
    let disposed = false;
    function onTransaction({ transaction }: { transaction: Transaction }): void {
      if (queued || !isRemoteChange(transaction)) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (disposed || editor.isDestroyed) return;
        reconcileEditor(editor);
      });
    }
    editor.on('transaction', onTransaction);
    return () => {
      disposed = true;
      editor.off('transaction', onTransaction);
    };
  }, [editor]);
}
