import { existsSync, readdirSync } from 'node:fs';
import type { KnipConfig } from 'knip';

const fidelityOnlyAppDeps = existsSync('packages/app/tests/fidelity') ? [] : ['remark-parse'];

const PREDICATE_DIR = 'lint-plugins/no-comments';

const differentialOnlyRootDeps =
  existsSync(PREDICATE_DIR) &&
  readdirSync(PREDICATE_DIR).some((entry) => entry.includes('.private.'))
    ? []
    : ['yaml'];

export default {
  tags: ['-lintignore'],
  ignore: ['.github/**'],
  ignoreDependencies: [
    ...differentialOnlyRootDeps,
    'lint-staged', // not sure if it's false positive
    'husky',
    '@lingui/babel-plugin-lingui-macro',
    '@lingui/format-po',
    'micromark',
    '@typescript/native',
    'zod',
  ],
  ignoreBinaries: [
    'ps', // process listing — diagnose.ts, process-scan.ts
    'lsof', // open-file listing — diagnose.ts, process-scan.ts
    'pgrep', // process lookup — process-scan.ts
    'taskkill', // Windows process-tree termination — mcp/npm-child.test-helper.ts
    'sw_vers', // macOS version query — bug-report.ts
    'mkfifo', // named-pipe creation — keepalive-orphan-reaping.test.ts
  ],
  ignoreIssues: {
    'test-support/**': ['exports', 'types'],
    'lint-plugins/**': ['exports', 'types'],
    'packages/app/src/locales/**': ['files'],
    'packages/app/src/components/ui/*': ['exports'],
    'docs/src/components/ui/*': ['exports'],
    'docs/source.config.ts': ['exports'],
    'packages/app/src/editor/extensions/internal-link.ts': ['exports', 'types'],
    'packages/app/src/editor/clipboard/serialize.ts': ['types'],
    '{tech-probes,reports,specs}/**': ['files', 'exports', 'types'],
    'tests/integration/**': ['files'],
    'packages/core/src/desktop-bridge.ts': ['files', 'types'],
    'packages/app/src/components/CloneDialog.tsx': ['files'],
    'docs/content/**/*.mdx': ['files'],
    'docs/_snippets/**/*.mdx': ['files'],
    'packages/app/src/components/McpConsentDialogBody.tsx': ['duplicates'],
    'packages/core/src/extensions/list.ts': ['duplicates'],
    'packages/app/src/lib/perf/index.ts': ['exports', 'types'],
    'packages/app/src/lib/perf/env-override.ts': ['types'],
    'packages/app/src/lib/perf/mark.ts': ['types'],
    'packages/app/src/editor/typing-burst-detector.ts': ['exports', 'types'],
    'packages/server/src/bridge-intake.ts': ['types'],
    '**/*.type-tests.ts': ['files'],
    'packages/server/src/http/request-validation.ts': ['exports', 'types'],
    'packages/server/src/http/error-response.ts': ['exports'],
    'packages/app/src/editor/http-client.ts': ['types'],
    '.{agents,codex}/skills/**': ['files'],
    'lint-plugins/no-comments/__fixtures__/**': ['files'],
    'lint-plugins/ok-rules/__fixtures__/**': ['files', 'exports'],
    '**/*.reads.{ts,mjs}': ['files', 'exports'],
    'scripts/assert-smoke-not-vacuous.mjs': ['files'],
    'scripts/assert-app-built.mjs': ['files'],
    'scripts/acp-mcp-rig/*.mjs': ['files'],
    'docs/src/lib/share-splash.ts': ['exports', 'types'],
    'packages/app/src/components/PublishToGitHubDialog.tsx': ['types'],
    'packages/app/src/components/ShareButton.tsx': ['types'],
    'packages/app/src/components/ShareReceiveDialog.tsx': ['types'],
    'packages/app/src/lib/share/clone-controller.ts': ['types'],
    'packages/app/src/lib/share/publish-wizard.ts': ['exports', 'types'],
    'packages/app/src/lib/share/receive-flow.ts': ['types'],
    'packages/app/src/lib/share/run-share-action.ts': ['types'],
    'packages/cli/src/commands/share/owners.ts': ['types'],
    'packages/cli/src/commands/share/publish.ts': ['types'],
    'packages/cli/src/commands/init.ts': ['types'],
    'packages/app/src/lib/desktop-bridge-types.ts': ['types'],
    'packages/server/src/share/git-context.ts': ['types'],
    'packages/server/src/git-preflight.ts': ['exports'],
    'packages/cli/src/commands/diagnose-health.ts': ['exports'],
    'packages/cli/src/commands/diagnose-health-checks/git.ts': ['exports'],
    'packages/cli/src/commands/diagnose-health-checks/index.ts': ['exports', 'types'],
    'packages/cli/src/commands/diagnose-health-checks/types.ts': ['types'],
  },
  workspaces: {
    '.': {
      entry: [
        'test-support/fixtures/no-net-connect/no-net-connect.fixture.ts',
        'test-support/fixtures/read-declarations/vitest.read-declarations-fixture.config.ts',
        'test-support/fixtures/read-declarations/*.cjs',
        'lint-plugins/no-comments/run-oxlint.test-helper.mjs',
      ],
      vitest: { entry: ['**/*.uncached.test.{ts,tsx,mjs}', '!.{agents,codex}/skills/**'] },
    },
    'packages/app': {
      entry: [
        'src/**/*.test.{ts,tsx}',
        'tests/**/*.{test,e2e}.ts',
        'tests/perf/lib/*.ts',
        'tests/dom/**/*.ts',
        'vite.prebuilt-dev.ts',
        'tests/stress/_helpers/reuse/server-supervisor.ts',
      ],
      project: 'src/**',
      ignoreDependencies: [
        'fuzzysort', // installed for workspace omnibar search ahead of the consumer wire-up
        '@testing-library/jest-dom', // side-effect import (`import '@testing-library/jest-dom'`) registers matchers
        ...fidelityOnlyAppDeps,
      ],
      ignoreFiles: ['src/server/agent-sim.ts'],
    },
    'packages/core': {
      entry: [
        'src/**/*.test.ts',
        'tests/**/*.ts',
        'src/markdown/fixtures/perf/generate.ts',
        'scripts/*.ts',
        'src/**/*.typelock.ts',
      ],
      project: 'src/**',
      ignoreDependencies: ['@tiptap/y-tiptap', 'y-prosemirror'],
    },
    docs: {
      entry: ['src/**/*.test.{ts,tsx}'],
    },
    'packages/server': {
      entry: ['src/**/*.test.ts', 'src/shadow-fixture-launch.test-helper.mjs'],
      project: 'src/**',
      ignoreDependencies: ['@types/shell-quote'],
    },
    'packages/cli': {
      entry: ['src/**/*.test.ts', 'scripts/*.ts', 'tests/**/*.ts'],
      ignoreDependencies: ['yjs', '@gitquire/app'],
    },
  },
} satisfies KnipConfig;
