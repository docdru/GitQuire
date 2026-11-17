#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

export const COLUMNS = ['queue', 'start', 'setup', 'install', 'build', 'test', 'other', 'total'];

const SETUP_STEP =
  /^(set up job|run actions\/checkout|run pnpm\/action-setup|run actions\/setup-node|run docker\/setup-buildx-action|run \.\/\.github\/actions\/setup|restore |log in )/i;
const INSTALL_STEP = /^install$/i;
const BUILD_STEP =
  /^(build|build image|build and push image|install playwright|playwright browsers)/i;
const OTHER_STEP =
  /^(post |complete job|upload |container logs|remove containers|show the formatting patch|save )/i;

export function stepPhase(name) {
  if (SETUP_STEP.test(name)) return 'setup';
  if (INSTALL_STEP.test(name)) return 'install';
  if (BUILD_STEP.test(name)) return 'build';
  if (OTHER_STEP.test(name)) return 'other';
  return 'test';
}

function seconds(from, to) {
  if (!from || !to) return 0;
  return Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
}

export function jobTimings(job, runCreatedAt) {
  const skipped = job.conclusion === 'skipped' || !job.started_at;
  const row = { name: job.name, conclusion: job.conclusion, skipped };
  for (const column of COLUMNS) row[column] = 0;
  if (skipped) return row;
  row.queue = seconds(job.created_at, job.started_at);
  row.start = seconds(runCreatedAt, job.started_at);
  row.total = seconds(job.started_at, job.completed_at);
  for (const step of job.steps ?? []) {
    row[stepPhase(step.name)] += seconds(step.started_at, step.completed_at);
  }
  return row;
}

export function runTimings(run, jobs) {
  const rows = jobs.map((job) => jobTimings(job, run.created_at));
  const ran = rows.filter((row) => !row.skipped);
  const end = jobs.reduce(
    (latest, job) => (job.completed_at && job.completed_at > latest ? job.completed_at : latest),
    run.created_at,
  );
  return {
    id: run.id,
    workflow: run.name,
    event: run.event,
    branch: run.head_branch,
    conclusion: run.conclusion,
    wall: seconds(run.created_at, end),
    jobMinutes: ran.reduce((sum, row) => sum + row.total, 0) / 60,
    jobsRun: ran.length,
    jobsSkipped: rows.length - ran.length,
    rows,
  };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function medianRows(runs) {
  const byName = new Map();
  for (const run of runs) {
    for (const row of run.rows) {
      if (row.skipped) continue;
      if (!byName.has(row.name)) byName.set(row.name, []);
      byName.get(row.name).push(row);
    }
  }
  return [...byName.entries()].map(([name, rows]) => {
    const merged = { name, runs: rows.length };
    for (const column of COLUMNS) merged[column] = median(rows.map((row) => row[column]));
    return merged;
  });
}

export function formatDuration(totalSeconds) {
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return minutes > 0 ? `${minutes}m${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

export function formatTable(rows, { title, showRuns = false } = {}) {
  const header = ['job', ...(showRuns ? ['runs'] : []), ...COLUMNS];
  const lines = [];
  if (title) lines.push(`**${title}**`, '');
  lines.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  for (const row of sorted) {
    const cells = row.skipped
      ? COLUMNS.map(() => '–')
      : COLUMNS.map((column) => formatDuration(row[column]));
    lines.push(`| ${[row.name, ...(showRuns ? [String(row.runs)] : []), ...cells].join(' | ')} |`);
  }
  return lines.join('\n');
}

export function formatSummary(runs) {
  const lines = [
    '| run | workflow | event | branch | wall | job minutes | jobs run | skipped |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const run of runs) {
    lines.push(
      `| ${run.id} | ${run.workflow} | ${run.event} | ${run.branch} | ${formatDuration(run.wall)} | ${run.jobMinutes.toFixed(1)} | ${run.jobsRun} | ${run.jobsSkipped} |`,
    );
  }
  if (runs.length > 1) {
    lines.push(
      `| median | | | | ${formatDuration(median(runs.map((run) => run.wall)))} | ${median(runs.map((run) => run.jobMinutes)).toFixed(1)} | | |`,
    );
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = { repo: 'docdru/GitQuire', json: false, ids: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') options.repo = argv[++index];
    else if (arg === '--json') options.json = true;
    else if (/^\d+$/.test(arg)) options.ids.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.ids.length === 0) {
    throw new Error('usage: node scripts/ci-timings.mjs [--repo owner/name] [--json] <run-id>...');
  }
  return options;
}

function ghJson(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

function fetchRun(repo, id) {
  const run = ghJson(`repos/${repo}/actions/runs/${id}`);
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const batch = ghJson(`repos/${repo}/actions/runs/${id}/jobs?per_page=100&page=${page}`);
    jobs.push(...batch.jobs);
    if (jobs.length >= batch.total_count || batch.jobs.length === 0) break;
  }
  return runTimings(run, jobs);
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const runs = options.ids.map((id) => fetchRun(options.repo, id));
    if (options.json) {
      console.log(JSON.stringify(runs, null, 2));
    } else if (runs.length === 1) {
      const [run] = runs;
      console.log(formatSummary(runs));
      console.log('');
      console.log(formatTable(run.rows));
    } else {
      console.log(formatSummary(runs));
      const workflows = [...new Set(runs.map((run) => run.workflow))];
      for (const workflow of workflows) {
        const subset = runs.filter((run) => run.workflow === workflow);
        console.log('');
        console.log(
          formatTable(medianRows(subset), {
            title: `${workflow}: median of ${subset.length} runs`,
            showRuns: true,
          }),
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
