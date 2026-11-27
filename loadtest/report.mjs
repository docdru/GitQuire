import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { evaluate } from './lib/verdict.mjs';

const { values } = parseArgs({
  options: {
    results: { type: 'string', default: 'loadtest/results' },
    baseline: { type: 'string' },
    out: { type: 'string', default: 'loadtest/results/report.md' },
    threshold: { type: 'string', default: '0.3' },
  },
});

const LEVEL_LABEL = {
  s0: (l) => `${l.pages} pages`,
  s1: (l) => `${l.editors} on one page`,
  s2: (l) => `${l.people} people`,
  s3: (l) => `${l.pages} pages, ${l.commits} commits`,
  s4: (l) => `${l.wikis} ${l.wikis === 1 ? 'wiki' : 'wikis'} open`,
  s5: (l) => `${l.drafts} ${l.drafts === 1 ? 'draft' : 'drafts'} in use`,
  s6: (l) => l.phase,
  s9: (l) => `${l.people} people, ${l.minutes} min`,
};

const CLAIM = {
  s1: (l) => `${l.editors} people typing in one page`,
  s2: (l) => `${l.people} people signed in to one wiki`,
  s3: (l) => `a wiki of ${l.pages} pages`,
  s4: (l) => `${l.wikis} ${l.wikis === 1 ? 'wiki' : 'wikis'} open at once`,
  s5: (l) => `${l.drafts} ${l.drafts === 1 ? 'draft' : 'drafts'} in use`,
};

function load(dir) {
  if (dir === undefined || !existsSync(dir)) return {};
  const out = {};
  for (const file of readdirSync(dir)) {
    if (!/^s\d+\.json$/.test(file)) continue;
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    out[data.scenario] = data;
  }
  return out;
}

function median(list) {
  const sorted = list.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function levelKey(level) {
  return JSON.stringify(level);
}

function byLevel(data) {
  const levels = new Map();
  for (const run of data.runs) {
    for (const result of run) {
      if (result.error) {
        const entry = levels.get('error') ?? { level: null, results: [] };
        entry.results.push(result);
        levels.set('error', entry);
        continue;
      }
      const key = levelKey(result.level);
      const entry = levels.get(key) ?? { level: result.level, results: [] };
      entry.results.push(result);
      levels.set(key, entry);
    }
  }
  return [...levels.values()];
}

function worstReasons(reasons) {
  const worst = new Map();
  for (const reason of reasons) {
    const match = /^(.*) (\d+(?:\.\d+)?) > (\d+(?:\.\d+)?)$/.exec(reason);
    if (match === null) {
      worst.set(reason, { text: reason, value: 0 });
      continue;
    }
    const value = Number(match[2]);
    const prev = worst.get(match[1]);
    if (prev === undefined || value > prev.value) {
      worst.set(match[1], {
        text: `${match[1]} up to ${Math.round(value)} (limit ${match[3]})`,
        value,
      });
    }
  }
  return [...worst.values()].map((w) => w.text);
}

function metric(results, pick) {
  return median(results.map(pick));
}

function perWikiMb(result) {
  const groups = result.memory?.groups ?? {};
  const wikis = Object.entries(groups).filter(([k]) => k.startsWith('wiki:'));
  if (wikis.length === 0) return null;
  return wikis.reduce((n, [, g]) => n + g.rssMb, 0) / wikis.length;
}

function worstApi(result) {
  const t = result.timings ?? {};
  let worst = null;
  for (const [name, s] of Object.entries(t)) {
    if (name.startsWith('api.') && s.p95 !== null && (worst === null || s.p95 > worst))
      worst = s.p95;
  }
  return worst;
}

function fmt(v, unit = '') {
  if (v === null || v === undefined) return '–';
  const n = typeof v === 'number' ? (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) : v;
  return `${n}${unit}`;
}

function summarise(data) {
  const rows = [];
  for (const entry of byLevel(data)) {
    if (entry.level === null) {
      rows.push({ error: entry.results.map((r) => r.error).join('; ') });
      continue;
    }
    const verdicts = entry.results.map((r) => evaluate(data.scenario, r));
    const passes = verdicts.filter((v) => v.pass).length;
    const r = entry.results;
    rows.push({
      level: entry.level,
      label: (LEVEL_LABEL[data.scenario] ?? levelKey)(entry.level),
      pass: passes * 2 > verdicts.length,
      passes,
      runs: verdicts.length,
      reasons: worstReasons(verdicts.flatMap((v) => v.reasons)),
      editPropagateP95: metric(r, (x) => x.timings?.['edit.propagate']?.p95),
      editAckP95: metric(r, (x) => x.timings?.['edit.ack']?.p95),
      pageOpenP95: metric(r, (x) => x.timings?.['page.open']?.p95),
      apiWorstP95: metric(r, worstApi),
      wikiProbeP95: metric(r, (x) => x.timings?.['probe.wiki']?.p95),
      coldOpenMax: metric(r, (x) => x.timings?.['wiki.coldOpen']?.max ?? x.firstOpenMs),
      saveToHostP95: metric(r, (x) => x.timings?.['sync.saveToHost']?.p95 ?? x.saveToHostMs),
      memoryPeakMb: metric(r, (x) => x.memory?.peakMb),
      perWikiMb: metric(r, perWikiMb),
      frontDoorMb: metric(r, (x) => x.memory?.groups?.['front-door']?.rssMb),
      slope: metric(r, (x) => x.memory?.slopeMbPerMin),
      cpuP95: metric(r, (x) => x.memory?.cpuCores?.p95),
      errors: metric(r, (x) => x.counts?.errors ?? 0),
      requests: metric(r, (x) => x.counts?.requests ?? 0),
      lost: Math.max(
        ...r.map((x) =>
          ['lost.converge', 'lost.server', 'lost.host', 'sync.neverReachedHost'].reduce(
            (n, k) => n + (x.counts?.[k] ?? 0),
            0,
          ),
        ),
      ),
      extra: {
        firstOpenMs: metric(r, (x) => x.firstOpenMs),
        backlinksReadyMs: metric(r, (x) => x.backlinksReadyMs),
        renameHubMs: metric(r, (x) => x.renameHubMs),
        backlinksAfterRenameMs: metric(r, (x) => x.backlinksAfterRenameMs),
        startMs: metric(r, (x) => x.startMs),
        noWikiMb: metric(r, (x) => x.memoryNoWiki?.peakMb),
        perDraftMb: metric(r, (x) => {
          const g = x.memory?.groups?.draft;
          return g === undefined ? null : g.rssMb / g.count;
        }),
        draftOpenP50: metric(r, (x) => x.timings?.['draft.open']?.p50),
        publishMs: metric(r, (x) => x.timings?.['draft.publish']?.max),
      },
    });
  }
  return rows;
}

const current = load(values.results);
const baseline = load(values.baseline);
const threshold = Number(values.threshold);
const lines = [];
const claims = [];
const regressions = [];
const anyMachine = Object.values(current)[0]?.machine;

lines.push('# GitQuire load test');
lines.push('');
if (anyMachine) {
  lines.push(
    `Machine: GitQuire container limited to **${anyMachine.limits.cpus} CPUs / ${anyMachine.limits.memory.toUpperCase()}B** (${anyMachine.target}) on a host with ${anyMachine.hostCpus} CPUs (${(anyMachine.cpuModel ?? '').trim()}); commit \`${(anyMachine.commit ?? '').slice(0, 7)}\`. Hold per level: ${Object.values(current)[0]?.hold} s, repeats: ${Object.values(current)[0]?.repeats}.`,
  );
  lines.push('');
}

for (const name of Object.keys(current).sort()) {
  const data = current[name];
  const rows = summarise(data);
  lines.push(`## ${name.toUpperCase()} — ${data.title}`);
  lines.push('');
  lines.push(
    '| Level | Result | Edit seen p95 | Edit ack p95 | Page open p95 | Slowest API p95 | Wiki resp. p95 | Save to host p95 | Memory peak | Per wiki process | CPU p95 | Errors | Lost edits (worst run) |',
  );
  lines.push(
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const row of rows) {
    if (row.error) {
      lines.push(`| error | ❌ ${row.error.replace(/\|/g, '/')} | | | | | | | | | | | |`);
      continue;
    }
    lines.push(
      `| ${row.label} | ${row.pass ? '✅' : '❌'} ${row.passes}/${row.runs} | ${fmt(row.editPropagateP95, ' ms')} | ${fmt(row.editAckP95, ' ms')} | ${fmt(row.pageOpenP95, ' ms')} | ${fmt(row.apiWorstP95, ' ms')} | ${fmt(row.wikiProbeP95, ' ms')} | ${fmt(row.saveToHostP95 === null ? null : row.saveToHostP95 / 1000, ' s')} | ${fmt(row.memoryPeakMb, ' MB')} | ${fmt(row.perWikiMb, ' MB')} | ${fmt(row.cpuP95)} | ${fmt(row.errors)}/${fmt(row.requests)} | ${fmt(row.lost)} |`,
    );
  }
  lines.push('');
  const failed = rows.filter((r) => !r.error && !r.pass);
  for (const row of failed) lines.push(`- ${row.label} failed: ${row.reasons.join('; ')}`);
  const extras = rows.filter((r) => !r.error && Object.values(r.extra).some((v) => v !== null));
  for (const row of extras) {
    const parts = [];
    if (row.extra.startMs !== null) parts.push(`server start ${fmt(row.extra.startMs, ' ms')}`);
    if (row.extra.noWikiMb !== null)
      parts.push(`front door alone ${fmt(row.extra.noWikiMb, ' MB')}`);
    if (row.extra.firstOpenMs !== null)
      parts.push(`first open of the wiki ${fmt(row.extra.firstOpenMs, ' ms')}`);
    if (row.extra.backlinksReadyMs !== null)
      parts.push(`backlinks ready ${fmt(row.extra.backlinksReadyMs, ' ms')}`);
    if (row.extra.renameHubMs !== null)
      parts.push(`rename of a page with 200+ backlinks ${fmt(row.extra.renameHubMs, ' ms')}`);
    if (row.extra.backlinksAfterRenameMs !== null)
      parts.push(`backlinks complete again after ${fmt(row.extra.backlinksAfterRenameMs, ' ms')}`);
    if (row.extra.perDraftMb !== null)
      parts.push(`about ${fmt(row.extra.perDraftMb, ' MB')} per draft process`);
    if (row.extra.draftOpenP50 !== null)
      parts.push(`a draft's first open ${fmt(row.extra.draftOpenP50, ' ms')} (median)`);
    if (row.extra.publishMs !== null) parts.push(`publish ${fmt(row.extra.publishMs, ' ms')}`);
    if (parts.length > 0) lines.push(`- ${row.label}: ${parts.join(', ')}`);
  }
  if (failed.length > 0 || extras.length > 0) lines.push('');
  if (CLAIM[name]) {
    const passing = [];
    for (const row of rows) {
      if (row.error || !row.pass) break;
      passing.push(row);
    }
    if (passing.length > 0) claims.push(CLAIM[name](passing[passing.length - 1].level));
  }
  const before = baseline[name];
  if (before !== undefined) {
    const old = new Map(
      summarise(before)
        .filter((r) => !r.error)
        .map((r) => [levelKey(r.level), r]),
    );
    for (const row of rows) {
      if (row.error) continue;
      const prev = old.get(levelKey(row.level));
      if (prev === undefined) continue;
      for (const key of [
        'editPropagateP95',
        'editAckP95',
        'pageOpenP95',
        'apiWorstP95',
        'memoryPeakMb',
        'perWikiMb',
      ]) {
        const a = prev[key];
        const b = row[key];
        if (typeof a !== 'number' || typeof b !== 'number') continue;
        const floor = key.endsWith('Mb') ? 50 : 50;
        if (b > a * (1 + threshold) && b - a > floor) {
          regressions.push(`${name} ${row.label}: ${key} ${fmt(a)} → ${fmt(b)}`);
        }
      }
      if (prev.pass && !row.pass)
        regressions.push(`${name} ${row.label}: passed before, fails now`);
    }
  }
}

const head = [];
if (claims.length > 0 && anyMachine) {
  head.push(
    `**Tested scale (${anyMachine.limits.cpus} vCPU / ${anyMachine.limits.memory.toUpperCase()}B):** ${claims.join(', ')} — each on its own, with no edit lost.`,
  );
  head.push('');
}
if (Object.keys(baseline).length > 0) {
  head.push(
    regressions.length === 0
      ? '**Against the last run:** no regression above the threshold.'
      : '**Regressions against the last run:**',
  );
  for (const r of regressions) head.push(`- ${r}`);
  head.push('');
}
lines.splice(anyMachine ? 4 : 2, 0, ...head);

const text = `${lines.join('\n')}\n`;
writeFileSync(values.out, text);
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, text, { flag: 'a' });
console.log(text);
if (regressions.length > 0 && process.env.LOADTEST_FAIL_ON_REGRESSION === '1') process.exitCode = 1;
