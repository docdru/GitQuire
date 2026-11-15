import type { FootnoteReference, Nodes, Parent, Root, Text } from 'mdast';
import { commentMarkPattern } from '../gitquire/comment-format.ts';
import { parseCommentTrailer } from '../gitquire/comment-threads.ts';

const SKIPPED_PARENTS: ReadonlySet<string> = new Set([
  'code',
  'inlineCode',
  'html',
  'math',
  'inlineMath',
  'yaml',
  'toml',
]);

type Phrasing = Text | FootnoteReference;

function rebase<T extends { offset: number }>(
  entries: readonly T[] | undefined,
  start: number,
  end: number,
): T[] | undefined {
  if (entries === undefined) return undefined;
  const kept = entries
    .filter((entry) => entry.offset >= start && entry.offset < end)
    .map((entry) => ({ ...entry, offset: entry.offset - start }));
  return kept.length === 0 ? undefined : kept;
}

function textPiece(node: Text, start: number, end: number): Text {
  const piece: Text = { type: 'text', value: node.value.slice(start, end) };
  const escapedChars = rebase(node.data?.escapedChars, start, end);
  const entityRefSpans = rebase(node.data?.entityRefSpans, start, end);
  if (escapedChars !== undefined || entityRefSpans !== undefined) {
    piece.data = {};
    if (escapedChars !== undefined) piece.data.escapedChars = escapedChars;
    if (entityRefSpans !== undefined) piece.data.entityRefSpans = entityRefSpans;
  }
  return piece;
}

function splitText(node: Text, labels: ReadonlySet<string>): Phrasing[] | undefined {
  if (node.data?.sourceRaw !== undefined) return undefined;
  const pieces: Phrasing[] = [];
  let cursor = 0;
  for (const match of node.value.matchAll(commentMarkPattern())) {
    const label = match[1] as string;
    if (!labels.has(label)) continue;
    const index = match.index ?? 0;
    if (index > cursor) pieces.push(textPiece(node, cursor, index));
    pieces.push({
      type: 'footnoteReference',
      identifier: label,
      label,
      data: { gitquireCommentMark: true },
    });
    cursor = index + match[0].length;
  }
  if (pieces.length === 0) return undefined;
  if (cursor < node.value.length) pieces.push(textPiece(node, cursor, node.value.length));
  return pieces;
}

function walk(node: Nodes, labels: ReadonlySet<string>): void {
  if (!('children' in node) || SKIPPED_PARENTS.has(node.type)) return;
  const parent = node as Parent;
  const next: Parent['children'] = [];
  let changed = false;
  for (const child of parent.children) {
    if (child.type === 'text') {
      const pieces = splitText(child, labels);
      if (pieces !== undefined) {
        next.push(...(pieces as Parent['children']));
        changed = true;
        continue;
      }
    } else {
      walk(child as Nodes, labels);
    }
    next.push(child);
  }
  if (changed) parent.children = next;
}

export function commentLabelsOf(trailer: string | undefined): Set<string> {
  if (trailer === undefined) return new Set();
  return new Set(parseCommentTrailer(trailer).threads.map((thread) => thread.id));
}

export function promoteCommentMarks(root: Root, labels: ReadonlySet<string>): void {
  if (labels.size === 0) return;
  walk(root, labels);
}

function trailerValue(root: Root): string | undefined {
  for (const child of root.children) {
    if (child.type === 'html' && child.data?.gitquireComments === true) return child.value;
  }
  return undefined;
}

function dropMarks(node: Nodes, labels: ReadonlySet<string>): void {
  if (!('children' in node)) return;
  const parent = node as Parent;
  const kept = parent.children.filter(
    (child) =>
      !(
        child.type === 'footnoteReference' &&
        child.data?.gitquireCommentMark === true &&
        !labels.has(child.identifier)
      ),
  );
  if (kept.length !== parent.children.length) parent.children = kept;
  for (const child of parent.children) dropMarks(child as Nodes, labels);
}

export function dropLooseCommentMarks(root: Root): void {
  dropMarks(root, commentLabelsOf(trailerValue(root)));
}
