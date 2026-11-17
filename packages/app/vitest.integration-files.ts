import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INTEGRATION_INCLUDE = [
  'tests/integration/**/*.test.ts?(x)',
  'tests/meta/**/*.test.ts?(x)',
];

export const WORKER_LIFETIME_TESTS = [
  'tests/meta/worker-server-lifetime.test.ts',
  'tests/meta/standalone-prebuilt-worker-lifetime.test.ts',
];

export const INTEGRATION_ONLY_EXCLUDE = [
  '**/per-session-um-perf.test.ts',
  ...WORKER_LIFETIME_TESTS,
];

const APP_ROOT = fileURLToPath(new URL('.', import.meta.url));

export function integrationTestFiles(root = APP_ROOT): string[] {
  const kept = new Set(WORKER_LIFETIME_TESTS);
  return globSync(
    ['tests/integration', 'tests/meta'].flatMap((dir) => [
      `${dir}/**/*.test.ts`,
      `${dir}/**/*.test.tsx`,
    ]),
    { cwd: root },
  )
    .map((path) => path.split('\\').join('/'))
    .filter((path) => !kept.has(path) && !path.endsWith('/per-session-um-perf.test.ts'))
    .sort();
}
