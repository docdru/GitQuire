import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { DurationShardSequencer } from './tests/duration-shards';
import { appVitestConfig } from './vitest.config';
import { INTEGRATION_INCLUDE, INTEGRATION_ONLY_EXCLUDE } from './vitest.integration-files';

export { WORKER_LIFETIME_TESTS } from './vitest.integration-files';

// `per-session-um-perf` is held out here because it is a perf tier with its own
// 60s-budget `test:perf:sessions` script. Bun's
// `--path-ignore-patterns=per-session-um-perf` was meant to exclude it but
// matched no path (bun reads the value as a glob), so it had been running in
// this tier under the 30s budget; the explicit exclude restores the intended
// split.
export const appIntegrationVitestConfig = {
  ...appVitestConfig,
  test: {
    ...appVitestConfig.test,
    include: [...INTEGRATION_INCLUDE],
    exclude: [...appVitestConfig.test.exclude, ...INTEGRATION_ONLY_EXCLUDE],
    sequence: { sequencer: DurationShardSequencer },
    // Per-test / per-hook budget for the CRDT convergence suite, carried over
    // from the bun `--timeout 30000`. Declared here (not only inherited) so the
    // CI test-coverage meta-guard reads it directly off this config.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run test files sequentially. Each file boots a real CRDT server with
    // WebSocket clients, grace-period timers, and debounced observer bridges;
    // running many files concurrently (the pool default) starves those timing
    // windows on a loaded event loop and makes convergence assertions flake.
    // Bun ran these files serially in one process, so this matches the timing
    // model the suite was written against.
    fileParallelism: false,
  },
} satisfies ViteUserConfig;

export default defineConfig(appIntegrationVitestConfig);
