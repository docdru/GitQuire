#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DURATIONS_FILE = fileURLToPath(
  new URL('../packages/app/tests/integration-durations.json', import.meta.url),
);
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const FILE_LINE =
  /[✓❯×] (tests\/(?:integration|meta)\/\S+\.test\.tsx?) \([^)]*\) ([0-9.]+)(ms|s)\b/;

export function parseFileDurations(log) {
  const durations = {};
  for (const raw of log.split('\n')) {
    const match = FILE_LINE.exec(raw.replace(ANSI, ''));
    if (!match) continue;
    const [, path, amount, unit] = match;
    const seconds = unit === 'ms' ? Number(amount) / 1000 : Number(amount);
    durations[path] = Math.round(seconds * 10) / 10;
  }
  return durations;
}

export function sortedDurations(durations) {
  return Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function gh(path) {
  return execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 256 << 20 });
}

if (import.meta.main) {
  const [runId, repo = 'docdru/GitQuire'] = process.argv.slice(2);
  if (!runId) {
    console.error('usage: node scripts/ci-integration-durations.mjs <run-id> [owner/repo]');
    process.exit(2);
  }
  const { jobs } = JSON.parse(gh(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`));
  const durations = {};
  for (const job of jobs.filter((candidate) => candidate.name.includes('app integration'))) {
    Object.assign(durations, parseFileDurations(gh(`repos/${repo}/actions/jobs/${job.id}/logs`)));
  }
  if (Object.keys(durations).length === 0) {
    console.error(`no app integration file durations found in run ${runId}`);
    process.exit(1);
  }
  writeFileSync(DURATIONS_FILE, `${JSON.stringify(sortedDurations(durations), null, 2)}\n`);
  console.log(`wrote ${Object.keys(durations).length} durations to ${DURATIONS_FILE}`);
}
