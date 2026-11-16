import { Node } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { renderInlineObjectText } from './input-rule-text.ts';

export const GITQUIRE_COMMENTS_NODE = 'gitquireComments';

export const ALLOW_COMMENT_TRAILER_REMOVAL = 'gitquireCommentsAllowRemoval';

const guardKey = new PluginKey('gitquireCommentsGuard');

const Y_SYNC_META_KEY = 'y-sync$';

function findTrailer(doc: PmNode): PmNode | undefined {
  let found: PmNode | undefined;
  doc.forEach((child) => {
    if (found === undefined && child.type.name === GITQUIRE_COMMENTS_NODE) found = child;
  });
  return found;
}

export const GitQuireComments = Node.create({
  name: GITQUIRE_COMMENTS_NODE,
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,
  priority: 60,

  addAttributes() {
    return {
      raw: { default: '', rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-gitquire-comments]', ignore: true }];
  },

  renderHTML() {
    return [
      'div',
      {
        'data-gitquire-comments': '',
        'data-clipboard-omit': 'true',
        contenteditable: 'false',
        hidden: '',
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: guardKey,
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const exempt = transactions.some(
            (tr) =>
              tr.getMeta(ALLOW_COMMENT_TRAILER_REMOVAL) === true ||
              tr.getMeta(Y_SYNC_META_KEY) !== undefined,
          );
          if (exempt) return null;
          const previous = findTrailer(oldState.doc);
          if (previous === undefined || findTrailer(newState.doc) !== undefined) return null;
          const tr = newState.tr.insert(newState.doc.content.size, previous);
          tr.setMeta('addToHistory', false);
          return tr;
        },
      }),
    ];
  },
});

export const GITQUIRE_COMMENT_MARK_NODE = 'gitquireCommentMark';

export const GitQuireCommentMark = Node.create({
  name: GITQUIRE_COMMENT_MARK_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,
  marks: '_',
  priority: 60,

  renderText: renderInlineObjectText,

  addAttributes() {
    return {
      id: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'sup[data-gitquire-comment-mark]',
        getAttrs: (element) => ({
          id: (element as HTMLElement).getAttribute('data-gitquire-comment-mark') ?? '',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      'sup',
      {
        'data-gitquire-comment-mark': String(node.attrs.id ?? ''),
        class: 'gitquire-comment-mark',
        contenteditable: 'false',
        'aria-label': 'Comment',
      },
      '💬',
    ];
  },
});
