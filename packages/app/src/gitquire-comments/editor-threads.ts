import { commentQuoteText } from '@gitquire/core/comments/leaf-text';
import {
  ALLOW_COMMENT_TRAILER_REMOVAL,
  GITQUIRE_COMMENT_MARK_NODE,
  GITQUIRE_COMMENTS_NODE,
} from '@gitquire/core/extensions/gitquire-comments';
import {
  parseCommentTrailer,
  serializeCommentTrailer,
} from '@gitquire/core/gitquire/comment-threads';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { captureSelectionContext, createAnchorResolver } from './anchor-search';
import { mergeThreads } from './thread-merge';
import type { Anchor, Thread } from './thread-ops';

interface TrailerLocation {
  pos: number;
  node: PMNode;
}

function findTrailers(doc: PMNode): TrailerLocation[] {
  const found: TrailerLocation[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name === GITQUIRE_COMMENTS_NODE) found.push({ pos: offset, node });
  });
  return found;
}

export function countTrailers(doc: PMNode): number {
  return findTrailers(doc).length;
}

export function commentBlockKey(doc: PMNode): string {
  return findTrailers(doc)
    .map((trailer) => String(trailer.node.attrs.raw ?? ''))
    .join('\n');
}

const parsedCache = new WeakMap<PMNode, Thread[]>();

const NO_THREADS: Thread[] = [];

function parseTrailer(node: PMNode): Thread[] {
  const cached = parsedCache.get(node);
  if (cached !== undefined) return cached;
  const threads = parseCommentTrailer(String(node.attrs.raw ?? '')).threads;
  parsedCache.set(node, threads);
  return threads;
}

export function readThreads(doc: PMNode): Thread[] {
  const [first, ...duplicates] = findTrailers(doc);
  if (first === undefined) return NO_THREADS;
  if (duplicates.length === 0) return parseTrailer(first.node);
  const cached = parsedCache.get(doc);
  if (cached !== undefined) return cached;
  let threads = parseTrailer(first.node);
  for (const duplicate of duplicates) {
    threads = mergeThreads([], parseTrailer(duplicate.node), threads);
  }
  parsedCache.set(doc, threads);
  return threads;
}

export interface MarkPlacement {
  id: string;
  pos: number;
}

export function findMarks(doc: PMNode): Map<string, number[]> {
  const marks = new Map<string, number[]>();
  doc.descendants((node, pos) => {
    if (node.type.name !== GITQUIRE_COMMENT_MARK_NODE) return true;
    const id = String(node.attrs.id ?? '');
    const list = marks.get(id);
    if (list === undefined) marks.set(id, [pos]);
    else list.push(pos);
    return false;
  });
  return marks;
}

const UNMARKABLE_PARENTS: ReadonlySet<string> = new Set(['heading', 'jsxInline']);

export function canPlaceMark(doc: PMNode, pos: number): boolean {
  if (pos <= 0 || pos > doc.content.size) return false;
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.inlineContent || parent.type.spec.code === true) return false;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (UNMARKABLE_PARENTS.has($pos.node(depth).type.name)) return false;
  }
  if ($pos.marks().some((mark) => mark.type.spec.code === true)) return false;
  const type = doc.type.schema.nodes[GITQUIRE_COMMENT_MARK_NODE];
  return type !== undefined && parent.type.contentMatch.matchType(type) !== null;
}

function writeTrailer(tr: Transaction, state: EditorState, raw: string | undefined): void {
  const type = state.schema.nodes[GITQUIRE_COMMENTS_NODE];
  if (type === undefined) return;
  const [first, ...duplicates] = findTrailers(state.doc);
  for (const duplicate of duplicates.reverse()) {
    tr.delete(duplicate.pos, duplicate.pos + duplicate.node.nodeSize);
  }
  if (raw === undefined) {
    if (first === undefined) return;
    tr.delete(first.pos, first.pos + first.node.nodeSize);
    tr.setMeta(ALLOW_COMMENT_TRAILER_REMOVAL, true);
    return;
  }
  if (first === undefined) {
    tr.insert(state.doc.content.size, type.create({ raw }));
    return;
  }
  if (first.node.attrs.raw !== raw) {
    tr.setNodeMarkup(first.pos, undefined, { ...first.node.attrs, raw });
  }
}

export function writeThreads(
  state: EditorState,
  threads: readonly Thread[],
  mark?: MarkPlacement,
): Transaction | undefined {
  if (state.schema.nodes[GITQUIRE_COMMENTS_NODE] === undefined) return undefined;
  const tr = state.tr;
  writeTrailer(tr, state, serializeCommentTrailer(threads));
  const kept = new Set(threads.filter((thread) => !thread.resolved).map((thread) => thread.id));
  const removed = readThreads(state.doc)
    .map((thread) => thread.id)
    .filter((id) => !kept.has(id));
  const marks = findMarks(state.doc);
  const deletions = removed.flatMap((id) => marks.get(id) ?? []).sort((a, b) => b - a);
  for (const pos of deletions) {
    const at = tr.mapping.map(pos);
    tr.delete(at, at + 1);
  }
  const markType = state.schema.nodes[GITQUIRE_COMMENT_MARK_NODE];
  if (mark !== undefined && markType !== undefined && kept.has(mark.id) && !marks.has(mark.id)) {
    if (canPlaceMark(state.doc, mark.pos)) {
      tr.insert(tr.mapping.map(mark.pos), markType.create({ id: mark.id }));
    }
  }
  return tr.docChanged ? tr : undefined;
}

export function anchorFromSelection(doc: PMNode, from: number, to: number): Anchor | undefined {
  if (from >= to) return undefined;
  const exact = commentQuoteText(doc, from, to).trim();
  if (exact === '') return undefined;
  const { prefix, suffix } = captureSelectionContext(doc, from, to);
  const anchor: Anchor = { exact };
  if (prefix !== '') anchor.prefix = prefix;
  if (suffix !== '') anchor.suffix = suffix;
  return anchor;
}

export interface PlacedThread {
  thread: Thread;
  range: { from: number; to: number } | null;
  marked: boolean;
}

function quoteBeforeMark(
  doc: PMNode,
  markPos: number,
  exact: string,
): { from: number; to: number } | null {
  const $pos = doc.resolve(markPos);
  const start = $pos.start();
  let text = '';
  const positions: number[] = [];
  doc.nodesBetween(start, markPos, (node, pos) => {
    if (!node.isText || node.text === undefined) return true;
    const from = Math.max(start, pos);
    const to = Math.min(markPos, pos + node.text.length);
    for (let at = from; at < to; at += 1) {
      text += node.text[at - pos];
      positions.push(at);
    }
    return false;
  });
  if (exact === '') return null;
  const trimmed = text.trimEnd();
  const at = trimmed.endsWith(exact) ? trimmed.length - exact.length : trimmed.lastIndexOf(exact);
  if (at === -1) return null;
  const from = positions[at];
  const last = positions[at + exact.length - 1];
  if (from === undefined || last === undefined) return null;
  return { from, to: last + 1 };
}

export function placeThreads(doc: PMNode, threads: readonly Thread[]): PlacedThread[] {
  if (threads.length === 0) return [];
  const marks = findMarks(doc);
  let resolve: ReturnType<typeof createAnchorResolver> | undefined;
  return threads.map((thread) => {
    const markPos = marks.get(thread.id)?.[0];
    if (markPos !== undefined) {
      const range = quoteBeforeMark(doc, markPos, thread.anchor.exact) ?? {
        from: markPos,
        to: markPos + 1,
      };
      return { thread, range, marked: true };
    }
    resolve ??= createAnchorResolver(doc);
    return {
      thread,
      range: resolve(thread.anchor.exact, {
        prefix: thread.anchor.prefix,
        suffix: thread.anchor.suffix,
      }),
      marked: false,
    };
  });
}
