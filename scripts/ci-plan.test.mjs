import { expect, test } from 'vitest';
import { classify, compressNames, parseArgs, plan, readSuites } from './ci-plan.mjs';

const suites = readSuites();
const all = suites.map((suite) => suite.suite);
const serverShards = ['server 1/4', 'server 2/4', 'server 3/4', 'server 4/4'];
const appUnit = ['app unit 1/4', 'app unit 2/4', 'app unit 3/4', 'app unit 4/4'];
const appIntegration = [1, 2, 3, 4].map((n) => `app integration, watching off ${n}/4`);

function pr(changedPaths, extra = {}) {
  return plan({ event: 'pull_request', baseRef: 'main', changedPaths, suites, ...extra });
}

const names = (result) => result.tests.map((suite) => suite.suite);

test('the suites file lists every suite the workflow ran before path selection', () => {
  expect(all).toEqual([
    'core',
    ...serverShards,
    ...appUnit,
    'app DOM',
    ...appIntegration,
    'cli',
    'docs',
    'uncached',
  ]);
  for (const suite of suites) {
    expect(suite.build).toMatch(/^pnpm exec turbo run build /);
    expect(suite.run).toBeTruthy();
    expect(suite.cache).toBeTruthy();
  }
});

test.each([
  ['push', { event: 'push', ref: 'main' }, 'full run: push to main'],
  ['workflow_dispatch', { event: 'workflow_dispatch' }, 'full run: workflow_dispatch'],
  [
    'the full-ci label',
    { event: 'pull_request', baseRef: 'main', labels: ['full-ci'], changedPaths: ['docs/a.md'] },
    'full run: label full-ci',
  ],
])('runs everything for %s', (_, input, summary) => {
  const result = plan({ suites, ...input });
  expect(result.full).toBe(true);
  expect(names(result)).toEqual(all);
  expect(result.docker).toBe(true);
  expect(result.skipped).toEqual([]);
  expect(result.summary).toBe(summary);
});

test.each([
  'pnpm-lock.yaml',
  'package.json',
  'turbo.json',
  'tsconfig.json',
  'patches/cmdk@1.1.1.patch',
  'test-support/vitest.base.ts',
  '.github/workflows/checks.yml',
  '.github/actions/setup/action.yml',
  'scripts/ci-plan.mjs',
  'lint-plugins/no-comments/README.md',
  'packages/core/src/index.ts',
])('a change in %s runs everything', (path) => {
  const result = pr([path, 'docs/index.mdx']);
  expect(result.full).toBe(true);
  expect(names(result)).toEqual(all);
  expect(result.docker).toBe(true);
  expect(result.summary).toBe(`full run: changes in ${path}`);
});

test('a path the table does not know runs everything', () => {
  const result = pr(['pnpm-workspace.yaml']);
  expect(result.full).toBe(true);
  expect(result.summary).toBe('full run: paths outside the table pnpm-workspace.yaml');
  expect(classify('deploy/compose.yaml')).toEqual({ full: true, unclassified: true });
});

test('a pull request with no changed paths runs everything', () => {
  expect(pr([]).full).toBe(true);
});

test('package.json counts as a full-run trigger only at the root', () => {
  expect(classify('package.json').full).toBe(true);
  expect(classify('packages/app/package.json').row.name).toBe('app');
});

test('docs only: checks and docs', () => {
  const result = pr(['docs/content/start.mdx', 'README.md', 'DEPLOY.md']);
  expect(result.full).toBe(false);
  expect(names(result)).toEqual(['docs']);
  expect(result.docker).toBe(false);
  expect(result.summary).toBe(
    'docs change: skipped core, server 1–4, app unit 1–4, app DOM, app integration, watching off 1–4, cli, uncached, Docker',
  );
});

test('Markdown inside a package counts as that package', () => {
  expect(classify('packages/server/README.md').row.name).toBe('server');
});

test('server: server, app unit, app DOM, app integration, cli, uncached and Docker', () => {
  const result = pr(['packages/server/src/http.ts']);
  expect(names(result)).toEqual([
    ...serverShards,
    ...appUnit,
    'app DOM',
    ...appIntegration,
    'cli',
    'uncached',
  ]);
  expect(result.docker).toBe(true);
  expect(result.skipped).toEqual(['core', 'docs']);
});

test('app: app unit, app DOM, app integration, uncached and Docker', () => {
  const result = pr(['packages/app/src/App.tsx']);
  expect(names(result)).toEqual([...appUnit, 'app DOM', ...appIntegration, 'uncached']);
  expect(result.docker).toBe(true);
  expect(result.summary).toBe('app change: skipped core, server 1–4, cli, docs');
});

test('cli: cli, uncached and Docker', () => {
  const result = pr(['packages/cli/src/index.ts']);
  expect(names(result)).toEqual(['cli', 'uncached']);
  expect(result.docker).toBe(true);
});

test.each(['Dockerfile', '.dockerignore', 'docker/entrypoint.sh', '.github/e2e/gitquire.e2e.mjs'])(
  '%s: Docker only',
  (path) => {
    const result = pr([path]);
    expect(result.full).toBe(false);
    expect(names(result)).toEqual([]);
    expect(result.docker).toBe(true);
  },
);

test('several rows: the union of their suites', () => {
  const result = pr(['packages/cli/src/index.ts', 'docs/a.mdx', 'Dockerfile']);
  expect(names(result)).toEqual(['cli', 'docs', 'uncached']);
  expect(result.docker).toBe(true);
  expect(result.summary).toMatch(/^cli \+ docs \+ Docker change: skipped /);
});

test('stacked: the table without Docker and app integration', () => {
  const result = pr(['packages/app/src/App.tsx'], { baseRef: 'ci/cache' });
  expect(result.stacked).toBe(true);
  expect(names(result)).toEqual([...appUnit, 'app DOM', 'uncached']);
  expect(result.docker).toBe(false);
  expect(result.summary).toBe(
    'app change; stacked on ci/cache: skipped core, server 1–4, app integration, watching off 1–4, cli, docs, Docker',
  );
});

test('stacked with a full-run trigger: everything but Docker and app integration', () => {
  const result = pr(['packages/core/src/index.ts'], { baseRef: 'ci/cache' });
  expect(result.full).toBe(true);
  expect(names(result)).toEqual(all.filter((name) => !appIntegration.includes(name)));
  expect(result.docker).toBe(false);
});

test('stacked with the full-ci label: everything', () => {
  const result = pr(['docs/a.mdx'], { baseRef: 'ci/cache', labels: ['full-ci'] });
  expect(result.stacked).toBe(false);
  expect(names(result)).toEqual(all);
  expect(result.docker).toBe(true);
});

test('shard names collapse into a range when all shards are listed', () => {
  expect(compressNames(['a 1/2', 'b', 'a 2/2', 'c 1/3'])).toEqual(['a 1–2', 'b', 'c (1 of 3)']);
});

test('reads the workflow inputs from the command line', () => {
  expect(
    parseArgs([
      '--event',
      'pull_request',
      '--base',
      'main',
      '--labels',
      '["full-ci"]',
      '--changed',
      '/tmp/x',
    ]),
  ).toEqual({
    event: 'pull_request',
    ref: '',
    baseRef: 'main',
    labels: ['full-ci'],
    changedFile: '/tmp/x',
  });
  expect(parseArgs(['--event', 'push', '--labels', 'null']).labels).toEqual([]);
  expect(() => parseArgs([])).toThrow(/usage/);
});
