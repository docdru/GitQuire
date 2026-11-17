import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

export const PER_FILE_OVERHEAD_SECONDS = 3;

const DURATIONS_FILE = fileURLToPath(new URL('./integration-durations.json', import.meta.url));

export function readDurations(file = DURATIONS_FILE): Record<string, number> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function partitionByDuration(
  paths: readonly string[],
  durations: Readonly<Record<string, number>>,
  count: number,
): string[][] {
  const unknownWeight = median(Object.values(durations));
  const weighted = paths
    .map((path) => ({
      path,
      weight: (durations[path] ?? unknownWeight) + PER_FILE_OVERHEAD_SECONDS,
    }))
    .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ total: 0, paths: [] as string[] }));
  for (const { path, weight } of weighted) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.total < lightest.total) lightest = shard;
    lightest.paths.push(path);
    lightest.total += weight;
  }
  return shards.map((shard) => shard.paths);
}

export class DurationShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const byPath = new Map(
      files.map((spec) => [relative(root, spec.moduleId).split('\\').join('/'), spec]),
    );
    const shards = partitionByDuration([...byPath.keys()], readDurations(), shard.count);
    return shards[shard.index - 1].map((path) => byPath.get(path) as TestSpecification);
  }
}
