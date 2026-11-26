import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serverLogs, settings, stopFake, stopServer } from './lib/env.mjs';
import { scenarios } from './lib/scenarios.mjs';
import { evaluate } from './lib/verdict.mjs';

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', multiple: true },
    hold: { type: 'string', default: process.env.LOADTEST_HOLD_SECONDS ?? '180' },
    repeats: { type: 'string', default: process.env.LOADTEST_REPEATS ?? '1' },
    quick: { type: 'boolean', default: false },
    out: { type: 'string', default: 'loadtest/results' },
    seed: { type: 'string', default: '1' },
  },
});

const names = values.scenario ?? Object.keys(scenarios);
const hold = Number(values.hold) * 1000;
const repeats = Number(values.repeats);

function machine() {
  const read = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  let image = null;
  if (settings.target === 'docker')
    image = read('docker', ['image', 'inspect', settings.image, '--format', '{{.Id}}']);
  return {
    target: settings.target,
    limits: { cpus: settings.cpus, memory: settings.memory },
    hostCpus: read('nproc', []),
    cpuModel: read('sh', ['-c', "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2"]),
    hostMemory: read('sh', ['-c', "grep MemTotal /proc/meminfo | tr -s ' ' | cut -d' ' -f2"]),
    image,
    commit: process.env.GITHUB_SHA ?? read('git', ['rev-parse', 'HEAD']),
    runner: process.env.RUNNER_NAME ?? null,
  };
}

function show(name, result) {
  const verdict = evaluate(name, result);
  console.log(
    `[loadtest] ${name} ${JSON.stringify(result.level)} -> ${verdict.pass ? 'pass' : `fail: ${verdict.reasons.join('; ')}`}`,
  );
  const { timings, ...rest } = result;
  console.log(`[loadtest] result ${JSON.stringify({ ...rest, memoryCurve: undefined })}`);
  console.log(`[loadtest] timings ${JSON.stringify(timings)}`);
  return verdict;
}

mkdirSync(values.out, { recursive: true });
const startedAt = new Date().toISOString();

for (const name of names) {
  const scenario = scenarios[name];
  if (scenario === undefined) throw new Error(`unknown scenario ${name}`);
  const levels = scenario.levels(values.quick);
  const runs = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const seed = Number(values.seed) + repeat;
    console.log(
      `[loadtest] ${name} repeat ${repeat + 1}/${repeats} levels ${JSON.stringify(levels)}`,
    );
    try {
      if (scenario.cumulative) {
        const results = await scenario.runAll(levels, { hold, seed });
        for (const result of results) show(name, result);
        runs.push(results);
      } else {
        const results = [];
        for (const level of levels) {
          const started = Date.now();
          console.log(`[loadtest] ${name} level ${JSON.stringify(level)}`);
          const result = await scenario.run(level, { hold, seed });
          result.wallMs = Date.now() - started;
          results.push(result);
          if (!show(name, result).pass) break;
        }
        runs.push(results);
      }
    } catch (err) {
      console.error(`[loadtest] ${name} failed: ${err.stack ?? err}`);
      console.error(serverLogs(120));
      runs.push([{ error: String(err.message ?? err) }]);
      await stopServer();
      await stopFake();
    }
  }
  const file = join(values.out, `${name}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ scenario: name, title: scenario.title, startedAt, machine: machine(), hold: values.hold, repeats, runs }, null, 2)}\n`,
  );
  console.log(`[loadtest] wrote ${file}`);
}
