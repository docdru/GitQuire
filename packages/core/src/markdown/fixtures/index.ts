import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

function fixturePath(...segments: string[]): string {
  return resolve(FIXTURES_DIR, ...segments);
}

interface GfmExample {
  section: string;
  markdown: string;
}

export function loadGfmExamples(): GfmExample[] {
  return JSON.parse(readFileSync(fixturePath('gfm', 'examples.json'), 'utf8')) as GfmExample[];
}

export function loadLargeRealistic(): string {
  return readFileSync(fixturePath('perf', 'large-realistic.md'), 'utf8');
}

export const PERF_BLOCK_COUNTS = [100, 1000, 5000, 10000, 20000] as const;
export type PerfBlockCount = (typeof PERF_BLOCK_COUNTS)[number];

export function loadPerfFixture(blockCount: PerfBlockCount): string {
  return readFileSync(fixturePath('perf', `${blockCount}.md`), 'utf8');
}
