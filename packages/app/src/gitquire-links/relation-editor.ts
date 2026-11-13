import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  type InlinePiece,
  type RelationFieldRange,
  relationEdits,
  relationFieldsInInline,
  relationOfLink,
} from './relation-fields';

export function inlinePieces(block: PMNode): InlinePiece[] {
  const pieces: InlinePiece[] = [];
  block.forEach((child) => {
    if (child.isText) {
      const isCode = child.marks.some((mark) => mark.type.name === 'code');
      pieces.push({ kind: isCode ? 'code' : 'text', text: child.text ?? '', size: child.nodeSize });
    } else if (child.type.name === 'wikiLink') {
      pieces.push({ kind: 'wikiLink', text: '', size: child.nodeSize });
    } else if (child.type.name === 'hardBreak') {
      pieces.push({ kind: 'break', text: '', size: child.nodeSize });
    } else {
      pieces.push({ kind: 'atom', text: '', size: child.nodeSize });
    }
  });
  return pieces;
}

function blockAround(doc: PMNode, linkPos: number) {
  if (linkPos < 0 || linkPos > doc.content.size) return undefined;
  const resolved = doc.resolve(linkPos);
  const block = resolved.parent;
  if (!block.isTextblock) return undefined;
  return { pieces: inlinePieces(block), start: resolved.start() };
}

export function relationAtLink(doc: PMNode, linkPos: number): string | null {
  const around = blockAround(doc, linkPos);
  return around === undefined ? null : relationOfLink(around.pieces, around.start, linkPos);
}

export function setLinkRelation(tr: Transaction, linkPos: number, relation: string | null) {
  const around = blockAround(tr.doc, linkPos);
  if (around === undefined) return tr;
  for (const edit of relationEdits(around.pieces, around.start, linkPos, relation)) {
    if (edit.insert === '') tr.delete(edit.from, edit.to);
    else tr.insertText(edit.insert, edit.from, edit.to);
  }
  return tr;
}

function fieldDecorations(field: RelationFieldRange): Decoration[] {
  const hidden = { class: 'gq-relation-syntax' };
  const decorations = [
    Decoration.inline(field.nameFrom, field.nameTo, {
      class: 'gq-relation-name',
      'data-gq-relation': field.relation,
    }),
  ];
  if (field.nameTo < field.valueFrom) {
    decorations.push(Decoration.inline(field.nameTo, field.valueFrom, hidden));
  }
  if (field.form === 'bracket') {
    decorations.push(Decoration.inline(field.from, field.nameFrom, hidden));
    decorations.push(Decoration.inline(field.to - 1, field.to, hidden));
  }
  return decorations;
}

export function relationDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  const { from, to } = state.selection;
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code === true || !node.textContent.includes('::')) return false;
    for (const field of relationFieldsInInline(inlinePieces(node), pos + 1)) {
      if (from <= field.valueFrom && to >= field.from) continue;
      decorations.push(...fieldDecorations(field));
    }
    return false;
  });
  return DecorationSet.create(state.doc, decorations);
}

const relationFieldsKey = new PluginKey<DecorationSet>('gitquireRelationFields');

export const GitQuireRelationFields = Extension.create({
  name: 'gitquireRelationFields',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: relationFieldsKey,
        state: {
          init: (_config, state) => relationDecorations(state),
          apply: (tr, previous, _oldState, newState) =>
            tr.docChanged || tr.selectionSet ? relationDecorations(newState) : previous,
        },
        props: {
          decorations: (state) => relationFieldsKey.getState(state),
        },
      }),
    ];
  },
});
