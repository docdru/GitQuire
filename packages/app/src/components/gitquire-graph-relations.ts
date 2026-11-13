import type { TypedLinkIndex } from '@/lib/gitquire/typed-links';

const LABEL_MIN_SCALE = 1.4;
const LABEL_FONT_PX = 9;

interface GraphEnd {
  id?: string | number;
  x?: number;
  y?: number;
}

interface GraphLinkEnds {
  source?: unknown;
  target?: unknown;
}

function endId(end: unknown): string | undefined {
  if (typeof end === 'string') return end;
  if (typeof end === 'object' && end !== null) {
    const id = (end as GraphEnd).id;
    return id === undefined ? undefined : String(id);
  }
  return undefined;
}

function endPoint(end: unknown): { x: number; y: number } | undefined {
  if (typeof end !== 'object' || end === null) return undefined;
  const { x, y } = end as GraphEnd;
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined;
}

export function graphLinkRelations(index: TypedLinkIndex, link: GraphLinkEnds): string[] {
  const source = endId(link.source);
  const target = endId(link.target);
  if (source === undefined || target === undefined) return [];
  return index.between(source, target);
}

export function graphLinkRelationLabel(index: TypedLinkIndex, link: GraphLinkEnds): string {
  return graphLinkRelations(index, link).join(', ');
}

export function drawGraphLinkRelation(
  index: TypedLinkIndex,
  link: GraphLinkEnds,
  ctx: CanvasRenderingContext2D,
  globalScale: number,
  color: string,
): void {
  if (globalScale < LABEL_MIN_SCALE) return;
  const label = graphLinkRelationLabel(index, link);
  if (label === '') return;
  const from = endPoint(link.source);
  const to = endPoint(link.target);
  if (from === undefined || to === undefined) return;
  ctx.save();
  ctx.font = `${LABEL_FONT_PX / globalScale}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(label, (from.x + to.x) / 2, (from.y + to.y) / 2);
  ctx.restore();
}
