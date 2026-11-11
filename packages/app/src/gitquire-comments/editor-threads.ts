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
import { captureSelectionContext, createAnchorResolver } from '@/comments/anchor-search';
import type { Anchor, Thread } from './thread-ops';

interface TrailerLocation {
  pos: number;
  node: PMNode;
}

function findTrailer(doc: PMNode): TrailerLocation | undefined {
  let found: TrailerLocation | undefined;
  doc.forEach((node, offset) => {
    if (found === undefined && node.type.name === GITQUIRE_COMMENTS_NODE) {
      found = { pos: offset, node };
    }
  });
  return found;
}

const parsedCache = new WeakMap<PMNode, Thread[]>();

const NO_THREADS: Thread[] = [];

export function readThreads(doc: PMNode): Thread[] {
  const trailer = findTrailer(doc);
  if (trailer === undefined) return NO_THREADS;
  const cached = parsedCache.get(trailer.node);
  if (cached !== undefined) return cached;
  const threads = parseCommentTrailer(String(trailer.node.attrs.raw ?? '')).threads;
  parsedCache.set(trailer.node, threads);
  return threads;
}

export function writeThreads(
  state: EditorState,
  threads: readonly Thread[],
): Transaction | undefined {
  const type = state.schema.nodes[GITQUIRE_COMMENTS_NODE];
  if (type === undefined) return undefined;
  const raw = serializeCommentTrailer(threads);
  const trailer = findTrailer(state.doc);
  const tr = state.tr;
  if (raw === undefined) {
    if (trailer === undefined) return undefined;
    tr.delete(trailer.pos, trailer.pos + trailer.node.nodeSize);
    tr.setMeta(ALLOW_COMMENT_TRAILER_REMOVAL, true);
    return tr;
  }
  if (trailer === undefined) {
    tr.insert(state.doc.content.size, type.create({ raw }));
    return tr;
  }
  if (trailer.node.attrs.raw === raw) return undefined;
  tr.setNodeMarkup(trailer.pos, undefined, { ...trailer.node.attrs, raw });
  return tr;
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
