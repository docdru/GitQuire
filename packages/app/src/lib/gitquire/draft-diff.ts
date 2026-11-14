import { diffWordsWithSpace } from 'diff';

export interface DiffSegment {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export interface KeyedSegment extends DiffSegment {
  key: string;
}

export interface DiffBlock {
  key: string;
  segments: KeyedSegment[];
  changed: boolean;
}

export interface DiffGap {
  key: string;
  gap: number;
}

const MAX_DIFF_CHARS = 120_000;

export function wordDiff(before: string, after: string): DiffSegment[] {
  if (before.length + after.length > MAX_DIFF_CHARS) {
    return [
      ...(before === '' ? [] : [{ kind: 'removed' as const, text: before }]),
      ...(after === '' ? [] : [{ kind: 'added' as const, text: after }]),
    ];
  }
  return diffWordsWithSpace(before, after).map((part) => ({
    kind: part.added ? 'added' : part.removed ? 'removed' : 'same',
    text: part.value,
  }));
}

export function diffBlocks(before: string, after: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let current: KeyedSegment[] = [];
  let counter = 0;
  const push = (kind: DiffSegment['kind'], text: string) => {
    counter += 1;
    current.push({ kind, text, key: `s${counter}` });
  };
  const flush = () => {
    if (current.length === 0) return;
    blocks.push({
      key: `b${blocks.length}`,
      segments: current,
      changed: current.some((segment) => segment.kind !== 'same'),
    });
    current = [];
  };
  for (const segment of wordDiff(before, after)) {
    const pieces = segment.text.split(/(\n\s*\n)/);
    for (const piece of pieces) {
      if (piece === '') continue;
      if (/^\n\s*\n$/.test(piece)) {
        if (segment.kind === 'same') {
          flush();
        } else {
          push(segment.kind, '¶');
        }
        continue;
      }
      push(segment.kind, piece);
    }
  }
  flush();
  return blocks;
}

export function collapseUnchanged(
  blocks: readonly DiffBlock[],
  context = 1,
): Array<DiffBlock | DiffGap> {
  const keep = blocks.map((_block, index) =>
    blocks.slice(Math.max(0, index - context), index + context + 1).some((near) => near.changed),
  );
  const out: Array<DiffBlock | DiffGap> = [];
  let gap = 0;
  blocks.forEach((block, index) => {
    if (keep[index]) {
      if (gap > 0) out.push({ key: `g${index}`, gap });
      gap = 0;
      out.push(block);
    } else {
      gap += 1;
    }
  });
  if (gap > 0) out.push({ key: 'g-end', gap });
  return out;
}

export function docNameOfPath(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path;
}

export function pathMatchesDoc(path: string, docName: string | null): boolean {
  return docName !== null && docNameOfPath(path) === docName;
}
