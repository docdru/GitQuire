#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SUITES_FILE = fileURLToPath(new URL('../.github/ci-suites.json', import.meta.url));
export const FULL_CI_LABEL = 'full-ci';
export const DOCKER = 'docker';
export const FULL_RUN_BASES = ['wikis-hosts'];

export const FULL_FILES = ['pnpm-lock.yaml', 'package.json', 'turbo.json', 'tsconfig.json'];
export const FULL_PREFIXES = [
  'patches/',
  'test-support/',
  '.github/',
  'scripts/',
  'lint-plugins/',
  'packages/core/',
];

export const ROWS = [
  {
    name: 'Docker',
    matches: (path) =>
      path === 'Dockerfile' ||
      path === '.dockerignore' ||
      path.startsWith('docker/') ||
      path.startsWith('.github/e2e/'),
    groups: [DOCKER],
  },
  {
    name: 'server',
    matches: (path) => path.startsWith('packages/server/'),
    groups: ['server', 'app-unit', 'app-dom', 'app-integration', 'cli', 'uncached', DOCKER],
  },
  {
    name: 'app',
    matches: (path) => path.startsWith('packages/app/'),
    groups: ['app-unit', 'app-dom', 'app-integration', 'uncached', DOCKER],
  },
  {
    name: 'cli',
    matches: (path) => path.startsWith('packages/cli/'),
    groups: ['cli', 'uncached', DOCKER],
  },
  {
    name: 'docs',
    matches: (path) =>
      path.startsWith('docs/') || (path.endsWith('.md') && !path.startsWith('packages/')),
    groups: ['docs'],
  },
];

export const STACKED_DROPS = [DOCKER];

export function readSuites(file = SUITES_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function classify(path) {
  const row = ROWS.find((candidate) => candidate.matches(path));
  if (row?.name === 'Docker') return { row };
  if (FULL_FILES.includes(path) || FULL_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return { full: true };
  }
  if (row) return { row };
  return { full: true, unclassified: true };
}

function fullReason({ event, ref, baseRef, labels, changedPaths }) {
  if (event === 'push') return `push to ${ref || 'main'}`;
  if (event !== 'pull_request') return event;
  if (labels.includes(FULL_CI_LABEL)) return `label ${FULL_CI_LABEL}`;
  if (FULL_RUN_BASES.includes(baseRef)) return `pull request against ${baseRef}`;
  if (changedPaths.length === 0) return 'no changed paths found';
  const triggers = changedPaths.filter((path) => classify(path).full);
  if (triggers.length === 0) return null;
  const unclassified = triggers.filter((path) => classify(path).unclassified);
  const shown = triggers.slice(0, 3).join(', ');
  const more = triggers.length > 3 ? ` and ${triggers.length - 3} more` : '';
  const kind = unclassified.length === triggers.length ? 'paths outside the table' : 'changes in';
  return `${kind} ${shown}${more}`;
}

export function compressNames(names) {
  const shards = new Map();
  const result = [];
  for (const name of names) {
    const match = /^(.*) (\d+)\/(\d+)$/.exec(name);
    if (!match) {
      result.push(name);
      continue;
    }
    const [, base, , total] = match;
    if (!shards.has(base)) {
      shards.set(base, { total: Number(total), count: 0, index: result.length });
      result.push(null);
    }
    shards.get(base).count += 1;
  }
  for (const [base, { total, count, index }] of shards) {
    result[index] = count === total ? `${base} 1–${total}` : `${base} (${count} of ${total})`;
  }
  return result;
}

export function plan({
  event,
  ref = '',
  baseRef = '',
  defaultBranch = 'main',
  labels = [],
  changedPaths = [],
  suites = readSuites(),
}) {
  const allGroups = new Set([...suites.map((suite) => suite.group), DOCKER]);
  const reason = fullReason({ event, ref, baseRef, labels, changedPaths });
  const full = reason !== null;
  let groups;
  let summary;
  if (full) {
    groups = new Set(allGroups);
    summary = `full run: ${reason}`;
  } else {
    groups = new Set();
    const rows = [];
    for (const path of changedPaths) {
      const { row } = classify(path);
      if (!rows.includes(row.name)) rows.push(row.name);
      for (const group of row.groups) groups.add(group);
    }
    summary = `${rows.join(' + ')} change`;
  }
  const stacked =
    event === 'pull_request' &&
    baseRef !== '' &&
    baseRef !== defaultBranch &&
    !FULL_RUN_BASES.includes(baseRef) &&
    !labels.includes(FULL_CI_LABEL);
  if (stacked) {
    for (const group of STACKED_DROPS) groups.delete(group);
    summary += `; stacked on ${baseRef}`;
  }
  const tests = suites.filter((suite) => groups.has(suite.group));
  const docker = groups.has(DOCKER);
  const skipped = compressNames([
    ...suites.filter((suite) => !groups.has(suite.group)).map((suite) => suite.suite),
    ...(docker ? [] : ['Docker']),
  ]);
  if (skipped.length > 0) summary += `: skipped ${skipped.join(', ')}`;
  return { full, stacked, summary, tests, docker, skipped };
}

export function parseArgs(argv) {
  const options = { event: '', ref: '', baseRef: '', labels: [], changedFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--event') options.event = value;
    else if (arg === '--ref') options.ref = value;
    else if (arg === '--base') options.baseRef = value;
    else if (arg === '--labels') options.labels = (value && JSON.parse(value)) || [];
    else if (arg === '--changed') options.changedFile = value;
    else throw new Error(`unknown argument: ${arg}`);
    index += 1;
  }
  if (!options.event) {
    throw new Error(
      'usage: node scripts/ci-plan.mjs --event <name> [--ref <ref>] [--base <branch>] [--labels <json>] [--changed <file>]',
    );
  }
  return options;
}

export function readChangedPaths(file) {
  if (!file) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatSummary(result, changedPaths) {
  const lines = [`### CI plan`, '', result.summary, ''];
  lines.push(
    `Runs: checks, ${[...result.tests.map((suite) => suite.suite), ...(result.docker ? ['Docker'] : [])].join(', ') || 'nothing else'}`,
  );
  if (changedPaths.length > 0) {
    lines.push('', `<details><summary>${changedPaths.length} changed paths</summary>`, '');
    for (const path of changedPaths.slice(0, 200)) lines.push(`- \`${path}\``);
    if (changedPaths.length > 200) lines.push(`- … and ${changedPaths.length - 200} more`);
    lines.push('', '</details>');
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const changedPaths = readChangedPaths(options.changedFile);
    const result = plan({ ...options, changedPaths });
    const outputs = {
      tests: JSON.stringify({ include: result.tests }),
      'has-tests': String(result.tests.length > 0),
      docker: String(result.docker),
      full: String(result.full),
    };
    console.log(result.summary);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(outputs)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      );
    } else {
      console.log(JSON.stringify(outputs, null, 2));
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatSummary(result, changedPaths));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
