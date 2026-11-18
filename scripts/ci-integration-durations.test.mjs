import { expect, test } from 'vitest';
import { parseFileDurations, sortedDurations } from './ci-integration-durations.mjs';

test('reads file durations from a vitest log, in seconds', () => {
  const log = [
    '2026-11-17T16:11:53Z  \u001b[32m✓\u001b[39m tests/integration/a.test.ts (14 tests) 4818ms',
    '2026-11-17T16:12:08Z  ✓ tests/meta/b.test.tsx (2 tests | 1 skipped) 12.5s',
    '2026-11-17T16:12:09Z  × tests/integration/c.test.ts (3 tests | 1 failed) 900ms',
    '2026-11-17T16:12:10Z  ✓ some other line 300ms',
  ].join('\n');
  expect(parseFileDurations(log)).toEqual({
    'tests/integration/a.test.ts': 4.8,
    'tests/meta/b.test.tsx': 12.5,
    'tests/integration/c.test.ts': 0.9,
  });
});

test('writes the table sorted by path', () => {
  expect(Object.keys(sortedDurations({ b: 1, a: 2 }))).toEqual(['a', 'b']);
});
