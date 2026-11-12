import type { Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { useEffect } from 'react';
import { commentBlockKey, countTrailers, readThreads, writeThreads } from './editor-threads';
import { notePendingWrite, type PendingWrite, reconcileThreads } from './thread-merge';
import type { Thread } from './thread-ops';

const pendingWrites = new WeakMap<Editor, PendingWrite[]>();

type SyncedChange = 'none' | 'remote' | 'undo';

function syncedCommentChange(transaction: Transaction): SyncedChange {
  const meta = transaction.getMeta(ySyncPluginKey) as
    | { isChangeOrigin?: boolean; isUndoRedoOperation?: boolean }
    | undefined;
  if (meta?.isChangeOrigin !== true || !transaction.docChanged) return 'none';
  if (commentBlockKey(transaction.before) === commentBlockKey(transaction.doc)) return 'none';
  return meta.isUndoRedoOperation === true ? 'undo' : 'remote';
}

export function writeAndTrack(editor: Editor, threads: readonly Thread[]): boolean {
  if (editor.isDestroyed) return false;
  const base = readThreads(editor.state.doc);
  const tr = writeThreads(editor.state, threads);
  if (tr === undefined) return false;
  const pending = pendingWrites.get(editor) ?? [];
  pendingWrites.set(editor, notePendingWrite(pending, base, threads, Date.now()));
  editor.view.dispatch(tr);
  return true;
}

function reconcileEditor(editor: Editor): void {
  const doc = editor.state.doc;
  const theirs = readThreads(doc);
  const result = reconcileThreads(pendingWrites.get(editor) ?? [], theirs, Date.now());
  pendingWrites.set(editor, result.pending);
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
      const change = syncedCommentChange(transaction);
      if (change === 'undo') pendingWrites.delete(editor);
      if (change !== 'remote' || queued) return;
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
