import { setTimeout as wait } from 'node:timers/promises';
import { WebSocket } from './deps.mjs';
import { inServer } from './env.mjs';

const INSPECTOR = 'http://127.0.0.1:9229';

export function profileWanted() {
  return ['1', 'on', 'true'].includes(String(process.env.LOADTEST_PROFILE ?? '').toLowerCase());
}

function signalInspector(key) {
  const [host, id] = key.split('-');
  return inServer(
    `h=${host}; i=${id}; for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null) || continue; case "$c" in *"-server $h-$i"|*"-server $h-$i "*) kill -USR1 \${p#/proc/} && echo \${p#/proc/};; esac; done; true`,
  ).trim();
}

function frameKey(frame) {
  const file = (frame.url ?? '').split('/').slice(-2).join('/');
  return `${frame.functionName || '(anonymous)'} ${file}:${(frame.lineNumber ?? 0) + 1}`;
}

export function findStalls(profile, thresholdMs = 300) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const idle = new Set(
    profile.nodes.filter((n) => n.callFrame.functionName === '(idle)').map((n) => n.id),
  );
  const stalls = [];
  let run = [];
  let runMs = 0;
  const close = () => {
    if (runMs >= thresholdMs) stalls.push(summarize(run, runMs, nodes, parent));
    run = [];
    runMs = 0;
  };
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    const ms = (profile.timeDeltas[i] ?? 0) / 1000;
    if (idle.has(id)) {
      close();
      continue;
    }
    run.push([id, ms]);
    runMs += ms;
  }
  close();
  return stalls;
}

function summarize(run, runMs, nodes, parent) {
  const self = new Map();
  const total = new Map();
  for (const [id, ms] of run) {
    const node = nodes.get(id);
    const key = frameKey(node.callFrame);
    self.set(key, (self.get(key) ?? 0) + ms);
    const seen = new Set();
    let at = id;
    while (at !== undefined) {
      const k = frameKey(nodes.get(at).callFrame);
      if (!seen.has(k)) {
        seen.add(k);
        total.set(k, (total.get(k) ?? 0) + ms);
      }
      at = parent.get(at);
    }
  }
  const top = (map, n) =>
    [...map]
      .filter(([k]) => !/^\((root|program|anonymous)\)/.test(k))
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
  return { ms: Math.round(runMs), self: top(self, 8), total: top(total, 12) };
}

export class StallProfiler {
  constructor({ key, windowMs = 10_000, thresholdMs = 300 }) {
    this.key = key;
    this.windowMs = windowMs;
    this.thresholdMs = thresholdMs;
    this.stalls = [];
    this.windows = 0;
    this.errors = [];
    this.next = 1;
    this.pending = new Map();
    this.running = false;
  }

  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async start() {
    const pid = signalInspector(this.key);
    if (pid === '') throw new Error(`no process for ${this.key}`);
    let target;
    for (let i = 0; i < 40 && target === undefined; i++) {
      await wait(250);
      try {
        const list = await (await fetch(`${INSPECTOR}/json/list`)).json();
        target = list[0]?.webSocketDebuggerUrl;
      } catch {}
    }
    if (target === undefined) throw new Error('inspector did not open');
    this.ws = new WebSocket(target);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const waiting = this.pending.get(msg.id);
      if (waiting === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(msg.error.message));
      else waiting.resolve(msg.result);
    });
    this.ws.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('inspector closed'));
      this.pending.clear();
      this.running = false;
    });
    await this.send('Profiler.enable');
    await this.send('Profiler.setSamplingInterval', { interval: 1000 });
    this.running = true;
    this.loop = this.run();
  }

  async run() {
    while (this.running) {
      try {
        await this.send('Profiler.start');
        await wait(this.windowMs);
        const { profile } = await this.send('Profiler.stop');
        this.windows++;
        for (const stall of findStalls(profile, this.thresholdMs)) this.stalls.push(stall);
      } catch (err) {
        this.errors.push(String(err.message ?? err));
        break;
      }
    }
  }

  async stop() {
    this.running = false;
    await this.loop?.catch(() => {});
    try {
      this.ws?.close();
    } catch {}
    return this.report();
  }

  report() {
    const byFn = new Map();
    for (const stall of this.stalls) {
      for (const { fn, ms } of stall.total) byFn.set(fn, (byFn.get(fn) ?? 0) + ms);
    }
    const longest = [...this.stalls].sort((a, b) => b.ms - a.ms).slice(0, 8);
    return {
      windows: this.windows,
      stallCount: this.stalls.length,
      stallMs: this.stalls.reduce((n, s) => n + s.ms, 0),
      topInStalls: [...byFn]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([fn, ms]) => ({ fn, ms })),
      longest,
      errors: this.errors,
    };
  }
}
