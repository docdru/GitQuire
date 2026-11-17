import { expect, test } from 'vitest';
import {
  formatDuration,
  formatTable,
  jobTimings,
  medianRows,
  parseArgs,
  runTimings,
  stepPhase,
} from './ci-timings.mjs';

const at = (seconds) => new Date(Date.UTC(2026, 10, 17, 8, 0, seconds)).toISOString();

function step(name, from, to) {
  return { name, started_at: at(from), completed_at: at(to) };
}

const testJob = {
  name: 'tests (server 1/4)',
  conclusion: 'success',
  created_at: at(2),
  started_at: at(5),
  completed_at: at(50),
  steps: [
    step('Set up job', 5, 6),
    step('Run actions/checkout@v7', 6, 8),
    step('Run ./.github/actions/setup', 8, 12),
    step('Install', 12, 20),
    step('Build', 20, 25),
    step('Test', 25, 48),
    step('Post Run actions/checkout@v7', 48, 49),
    step('Complete job', 49, 50),
  ],
};

test('sorts step names into phases', () => {
  expect(stepPhase('Set up job')).toBe('setup');
  expect(stepPhase('Run actions/setup-node@v4')).toBe('setup');
  expect(stepPhase('Install')).toBe('install');
  expect(stepPhase('Build')).toBe('build');
  expect(stepPhase('Build image')).toBe('build');
  expect(stepPhase('Install Playwright browsers')).toBe('build');
  expect(stepPhase('Test')).toBe('test');
  expect(stepPhase('Lint')).toBe('test');
  expect(stepPhase('Smoke test')).toBe('test');
  expect(stepPhase('Post Run actions/checkout@v7')).toBe('other');
  expect(stepPhase('Upload layout screenshots')).toBe('other');
});

test('adds up a job by phase and measures its queue from creation', () => {
  expect(jobTimings(testJob, at(0))).toEqual({
    name: 'tests (server 1/4)',
    conclusion: 'success',
    skipped: false,
    queue: 3,
    start: 5,
    setup: 7,
    install: 8,
    build: 5,
    test: 23,
    other: 2,
    total: 45,
  });
});

test('reports a skipped job with zero time and leaves it out of the job minutes', () => {
  const skipped = { name: 'publish', conclusion: 'skipped', created_at: at(1), steps: [] };
  const run = runTimings(
    { id: 1, name: 'Checks', event: 'push', head_branch: 'main', created_at: at(0) },
    [testJob, skipped],
  );
  expect(run.wall).toBe(50);
  expect(run.jobMinutes).toBe(0.75);
  expect(run.jobsRun).toBe(1);
  expect(run.jobsSkipped).toBe(1);
  expect(formatTable(run.rows)).toContain('| publish | – | – |');
});

test('takes the median per job across runs', () => {
  const runs = [10, 30, 20].map((testSeconds, index) =>
    runTimings({ id: index, name: 'Checks', created_at: at(0) }, [
      { ...testJob, steps: [step('Test', 5, 5 + testSeconds)] },
    ]),
  );
  const [row] = medianRows(runs);
  expect(row.runs).toBe(3);
  expect(row.test).toBe(20);
});

test('formats durations as minutes and seconds', () => {
  expect(formatDuration(9.4)).toBe('9s');
  expect(formatDuration(65)).toBe('1m05s');
  expect(formatDuration(600)).toBe('10m00s');
});

test('reads run ids and options from the command line', () => {
  expect(parseArgs(['--repo', 'a/b', '--json', '12', '34'])).toEqual({
    repo: 'a/b',
    json: true,
    ids: ['12', '34'],
  });
  expect(() => parseArgs([])).toThrow(/usage/);
  expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
});
