import { expect, test } from 'vitest';
import { partitionByDuration, readDurations } from './duration-shards.ts';

test('every file lands in exactly one shard', () => {
  const paths = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const shards = partitionByDuration(paths, { a: 10, b: 5 }, 3);
  expect(shards.flat().sort()).toEqual(paths);
});

test('a long file gets a shard of its own while the short ones share the rest', () => {
  const durations = { long: 170, s1: 10, s2: 10, s3: 10, s4: 10 };
  const shards = partitionByDuration(Object.keys(durations), durations, 2);
  expect(shards).toEqual([['long'], ['s1', 's2', 's3', 's4']]);
});

test('the split does not depend on the order the files come in', () => {
  const durations = { a: 30, b: 20, c: 20, d: 10, e: 5 };
  const forward = partitionByDuration(['a', 'b', 'c', 'd', 'e'], durations, 2);
  const backward = partitionByDuration(['e', 'd', 'c', 'b', 'a'], durations, 2);
  expect(backward).toEqual(forward);
});

test('a file missing from the table weighs as much as the median file', () => {
  const shards = partitionByDuration(['new', 'x', 'y', 'z'], { x: 1, y: 5, z: 100 }, 2);
  expect(shards).toEqual([['z'], ['new', 'y', 'x']]);
});

test('the checked-in table lists integration test files by path', () => {
  const durations = readDurations();
  const paths = Object.keys(durations);
  expect(paths.length).toBeGreaterThan(100);
  for (const path of paths) expect(path).toMatch(/^tests\/(integration|meta)\/.+\.test\.tsx?$/);
});
