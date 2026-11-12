import { commentQuoteText } from '@inkeep/open-knowledge-core/comments/leaf-text';
import {
  ALLOW_COMMENT_TRAILER_REMOVAL,
  GITQUIRE_COMMENTS_NODE,
} from '@inkeep/open-knowledge-core/extensions/gitquire-comments';
import {
  parseCommentTrailer,
  serializeCommentTrailer,
} from '@inkeep/open-knowledge-core/gitquire/comment-threads';
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

export function writeThreads(
  state: EditorState,
  threads: readonly Thread[],
): Transaction | undefined {
  const type = state.schema.nodes[GITQUIRE_COMMENTS_NODE];
  if (type === undefined) return undefined;
  const raw = serializeCommentTrailer(threads);
  const [first, ...duplicates] = findTrailers(state.doc);
  const tr = state.tr;
  for (const duplicate of duplicates.reverse()) {
    tr.delete(duplicate.pos, duplicate.pos + duplicate.node.nodeSize);
  }
  if (raw === undefined) {
    if (first === undefined) return undefined;
    tr.delete(first.pos, first.pos + first.node.nodeSize);
    tr.setMeta(ALLOW_COMMENT_TRAILER_REMOVAL, true);
    return tr;
  }
  if (first === undefined) {
    tr.insert(state.doc.content.size, type.create({ raw }));
    return tr;
  }
  if (first.node.attrs.raw !== raw) {
    tr.setNodeMarkup(first.pos, undefined, { ...first.node.attrs, raw });
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
}

export function placeThreads(doc: PMNode, threads: readonly Thread[]): PlacedThread[] {
  if (threads.length === 0) return [];
  const resolve = createAnchorResolver(doc);
  return threads.map((thread) => ({
    thread,
    range: resolve(thread.anchor.exact, {
      prefix: thread.anchor.prefix,
      suffix: thread.anchor.suffix,
    }),
  }));
}
