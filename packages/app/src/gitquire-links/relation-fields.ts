import {
  inlineRelationFields,
  normalizeRelation,
} from '@inkeep/open-knowledge-core/gitquire/typed-links';

const WIKI_LINK_PLACEHOLDER = '[[@]]';
const ATOM_PLACEHOLDER = '￼';

export interface InlinePiece {
  kind: 'text' | 'code' | 'wikiLink' | 'break' | 'atom';
  text: string;
  size: number;
}

interface Segment {
  kind: InlinePiece['kind'];
  textStart: number;
  textEnd: number;
  pos: number;
  size: number;
}

export interface RelationFieldRange {
  relation: string;
  form: 'line' | 'bracket';
  from: number;
  nameFrom: number;
  nameTo: number;
  valueFrom: number;
  to: number;
  linkPositions: number[];
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

function pieceText(piece: InlinePiece): string {
  if (piece.kind === 'text') return piece.text;
  if (piece.kind === 'code') return ATOM_PLACEHOLDER.repeat(piece.text.length);
  if (piece.kind === 'wikiLink') return WIKI_LINK_PLACEHOLDER;
  if (piece.kind === 'break') return '\n';
  return ATOM_PLACEHOLDER;
}

function layout(pieces: readonly InlinePiece[], start: number) {
  const segments: Segment[] = [];
  let text = '';
  let pos = start;
  for (const piece of pieces) {
    const value = pieceText(piece);
    segments.push({
      kind: piece.kind,
      textStart: text.length,
      textEnd: text.length + value.length,
      pos,
      size: piece.size,
    });
    text += value;
    pos += piece.size;
  }
  return { text, segments, end: pos };
}

function toDocPos(segments: readonly Segment[], end: number, offset: number): number {
  for (const segment of segments) {
    if (offset < segment.textStart || offset >= segment.textEnd) continue;
    if (segment.kind === 'text' || segment.kind === 'code') {
      return segment.pos + (offset - segment.textStart);
    }
    return segment.pos;
  }
  return end;
}

export function relationFieldsInInline(
  pieces: readonly InlinePiece[],
  start: number,
): RelationFieldRange[] {
  const { text, segments, end } = layout(pieces, start);
  if (!text.includes('::')) return [];
  const fields: RelationFieldRange[] = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    for (const field of inlineRelationFields(line)) {
      if (!field.value.includes(WIKI_LINK_PLACEHOLDER)) continue;
      const valueStart = lineStart + field.valueStart;
      const valueEnd = lineStart + (field.form === 'line' ? field.end : field.end - 1);
      const at = (offset: number) => toDocPos(segments, end, lineStart + offset);
      fields.push({
        relation: field.relation,
        form: field.form,
        from: at(field.start),
        nameFrom: at(field.nameStart),
        nameTo: at(field.nameEnd),
        valueFrom: at(field.valueStart),
        to: at(field.end),
        linkPositions: segments
          .filter(
            (segment) =>
              segment.kind === 'wikiLink' &&
              segment.textStart >= valueStart &&
              segment.textEnd <= valueEnd,
          )
          .map((segment) => segment.pos),
      });
    }
    lineStart += line.length + 1;
  }
  return fields;
}

function onlyWhitespaceBefore(
  pieces: readonly InlinePiece[],
  start: number,
  linkPos: number,
): boolean {
  let pos = start;
  let onlyWhitespace = true;
  for (const piece of pieces) {
    if (pos >= linkPos) break;
    if (piece.kind === 'break') onlyWhitespace = true;
    else if (piece.kind !== 'text' || piece.text.trim() !== '') onlyWhitespace = false;
    pos += piece.size;
  }
  return onlyWhitespace;
}

function sizeAt(pieces: readonly InlinePiece[], start: number, at: number): number {
  let pos = start;
  for (const piece of pieces) {
    if (pos === at) return piece.size;
    pos += piece.size;
  }
  return 1;
}

export function relationOfLink(
  pieces: readonly InlinePiece[],
  start: number,
  linkPos: number,
): string | null {
  const field = relationFieldsInInline(pieces, start).find((candidate) =>
    candidate.linkPositions.includes(linkPos),
  );
  return field?.relation ?? null;
}

export function relationEdits(
  pieces: readonly InlinePiece[],
  start: number,
  linkPos: number,
  relation: string | null,
): TextEdit[] {
  const next = relation === null || relation.trim() === '' ? null : normalizeRelation(relation);
  if (next === undefined) return [];
  const field = relationFieldsInInline(pieces, start).find((candidate) =>
    candidate.linkPositions.includes(linkPos),
  );
  if (field !== undefined) {
    if (next === field.relation) return [];
    if (next !== null) return [{ from: field.nameFrom, to: field.nameTo, insert: next }];
    if (field.form === 'line') return [{ from: field.from, to: field.valueFrom, insert: '' }];
    return [
      { from: field.to - 1, to: field.to, insert: '' },
      { from: field.from, to: field.valueFrom, insert: '' },
    ];
  }
  if (next === null) return [];
  if (onlyWhitespaceBefore(pieces, start, linkPos)) {
    return [{ from: linkPos, to: linkPos, insert: `${next}:: ` }];
  }
  const linkEnd = linkPos + sizeAt(pieces, start, linkPos);
  return [
    { from: linkEnd, to: linkEnd, insert: ')' },
    { from: linkPos, to: linkPos, insert: `(${next}:: ` },
  ];
}

export function isValidRelationInput(value: string): boolean {
  return value.trim() === '' || normalizeRelation(value) !== undefined;
}
