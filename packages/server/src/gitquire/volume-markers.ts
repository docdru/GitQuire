import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SINGLE_WIKI_MARKERS = ['.git', '.gitquire', '.ok'] as const;
const MOVE_MARKERS = ['.gitquire-moving-in', '.gitquire-moving-back'] as const;

export function singleWikiMarker(dataDir: string): string | undefined {
  return [...MOVE_MARKERS, ...SINGLE_WIKI_MARKERS].find((name) => existsSync(join(dataDir, name)));
}

export function interruptedMove(dataDir: string): boolean {
  return MOVE_MARKERS.some((name) => existsSync(join(dataDir, name)));
}
