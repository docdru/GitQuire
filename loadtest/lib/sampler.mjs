import { inServer, serverRootPid, settings } from './env.mjs';

const PROC_SCRIPT =
  'for p in /proc/[0-9]*; do s=$(cat $p/stat 2>/dev/null) || continue; r=$(grep VmRSS $p/status 2>/dev/null | tr -s " " | cut -d" " -f2); c=$(tr "\\0" " " < $p/cmdline 2>/dev/null | cut -c1-160); echo "$s|${r:-0}|$c"; done; echo "@mem $(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0)"';

const TICKS = 100;

function parse(text) {
  const procs = new Map();
  let cgroup = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('@mem ')) {
      cgroup = Number(line.slice(5)) || 0;
      continue;
    }
    if (line.trim() === '') continue;
    const [stat, rss, cmd] = line.split('|');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const pid = Number(stat.slice(0, stat.indexOf(' ')));
    procs.set(pid, {
      pid,
      ppid: Number(fields[1]),
      cpu: (Number(fields[11]) + Number(fields[12])) / TICKS,
      rssKb: Number(rss) || 0,
      cmd: (cmd ?? '').trim(),
    });
  }
  return { procs, cgroup };
}

function kindOf(proc, rootPid) {
  if (proc.pid === rootPid) return 'front-door';
  const match = /-server (\S+)/.exec(proc.cmd);
  if (match)
    return match[1].startsWith('draft') || proc.cmd.includes('draft')
      ? `draft:${match[1]}`
      : `wiki:${match[1]}`;
  if (/^git\b|\/git\b/.test(proc.cmd)) return 'git';
  return 'other';
}

export function tree(procs, rootPid) {
  const keep = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs.values()) {
      if (!keep.has(p.pid) && keep.has(p.ppid)) {
        keep.add(p.pid);
        grew = true;
      }
    }
  }
  return [...procs.values()].filter((p) => keep.has(p.pid));
}

export class Sampler {
  constructor(intervalMs = 5000) {
    this.intervalMs = intervalMs;
    this.samples = [];
    this.last = undefined;
    this.timer = undefined;
    this.phase = 'start';
  }

  take() {
    const rootPid = serverRootPid();
    if (rootPid === undefined) return;
    let parsed;
    try {
      parsed = parse(inServer(PROC_SCRIPT));
    } catch {
      return;
    }
    const at = Date.now();
    const own = tree(parsed.procs, rootPid);
    const groups = {};
    let rssKb = 0;
    let cpuSeconds = 0;
    for (const p of own) {
      const kind = kindOf(p, rootPid);
      const prev = this.last?.byPid.get(p.pid);
      const used = prev === undefined ? 0 : Math.max(0, p.cpu - prev.cpu);
      const group = (groups[kind] ??= { rssMb: 0, cpuSeconds: 0, count: 0 });
      group.rssMb += p.rssKb / 1024;
      group.cpuSeconds += used;
      group.count += 1;
      rssKb += p.rssKb;
      cpuSeconds += used;
    }
    const seconds = this.last === undefined ? 0 : (at - this.last.at) / 1000;
    const sample = {
      at,
      phase: this.phase,
      rssMb: rssKb / 1024,
      cgroupMb: settings.target === 'docker' ? parsed.cgroup / 1048576 : rssKb / 1024,
      cpuCores: seconds > 0 ? cpuSeconds / seconds : 0,
      processes: own.length,
      groups: Object.fromEntries(
        Object.entries(groups).map(([k, g]) => [
          k,
          {
            rssMb: Math.round(g.rssMb),
            cpuCores: seconds > 0 ? +(g.cpuSeconds / seconds).toFixed(3) : 0,
            count: g.count,
          },
        ]),
      ),
    };
    this.last = { at, byPid: new Map(own.map((p) => [p.pid, p])) };
    if (seconds > 0) this.samples.push(sample);
    return sample;
  }

  start() {
    this.take();
    this.timer = setInterval(() => this.take(), this.intervalMs);
    this.timer.unref();
  }

  mark(phase) {
    this.phase = phase;
  }

  stop() {
    clearInterval(this.timer);
    this.take();
    return this.samples;
  }
}
