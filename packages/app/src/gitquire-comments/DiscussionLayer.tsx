import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';
import { useEffect } from 'react';
import { placeThreads, readThreads } from './editor-threads';
import { getDiscussionUi, openDiscussions, subscribeDiscussionUi } from './ui-store';

const discussionKey = new PluginKey<DecorationSet>('gitquireDiscussions');

const ANCHOR_CLASS =
  'gq-discussion-anchor cursor-pointer rounded-sm bg-amber-200/40 underline decoration-amber-500/70 decoration-2 underline-offset-4 dark:bg-amber-400/15';
const ACTIVE_CLASS = 'gq-discussion-anchor-active bg-amber-300/60 dark:bg-amber-400/30';
const DRAFT_CLASS = 'gq-discussion-draft rounded-sm bg-sky-200/50 dark:bg-sky-400/20';

function buildDecorations(docName: string, doc: PMNode): DecorationSet {
  const ui = getDiscussionUi();
  const decorations: Decoration[] = [];
  const open = readThreads(doc).filter((thread) => !thread.resolved);
  for (const { thread, range } of placeThreads(doc, open)) {
    if (range === null || range.from >= range.to) continue;
    const active = ui.docName === docName && ui.activeThreadId === thread.id;
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: active ? `${ANCHOR_CLASS} ${ACTIVE_CLASS}` : ANCHOR_CLASS,
        'data-discussion-id': thread.id,
      }),
    );
  }
  const draft = ui.docName === docName ? ui.draft : null;
  if (draft !== null && draft.from < draft.to && draft.to <= doc.content.size) {
    decorations.push(Decoration.inline(draft.from, draft.to, { class: DRAFT_CLASS }));
  }
  return DecorationSet.create(doc, decorations);
}

function createDiscussionPlugin(docName: string): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: discussionKey,
    state: {
      init: (_config, state) => buildDecorations(docName, state.doc),
      apply: (tr, previous) => {
        if (tr.docChanged || tr.getMeta(discussionKey) !== undefined) {
          return buildDecorations(docName, tr.doc);
        }
        return previous;
      },
    },
    props: {
      decorations: (state) => discussionKey.getState(state),
      handleClick: (view, pos) => {
        const open = readThreads(view.state.doc).filter((thread) => !thread.resolved);
        let hit: { id: string; size: number } | undefined;
        for (const { thread, range } of placeThreads(view.state.doc, open)) {
          if (range === null || pos < range.from || pos > range.to) continue;
          const size = range.to - range.from;
          if (hit === undefined || size < hit.size) hit = { id: thread.id, size };
        }
        if (hit !== undefined) openDiscussions(docName, hit.id);
        return false;
      },
    },
  });
}

export function DiscussionLayer({ editor, docName }: { editor: Editor; docName: string }) {
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || editor.isDestroyed) return;
      editor.registerPlugin(createDiscussionPlugin(docName));
    });
    const unsubscribe = subscribeDiscussionUi(() => {
      if (disposed || editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(discussionKey, true));
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (!editor.isDestroyed) editor.unregisterPlugin(discussionKey);
    };
  }, [editor, docName]);
  return null;
}
