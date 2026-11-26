export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[at];
}

export function summary(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, p50: null, p95: null, p99: null, max: null };
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1]),
  };
}

export class Recorder {
  constructor() {
    this.values = new Map();
    this.counts = new Map();
  }

  add(name, ms) {
    let list = this.values.get(name);
    if (list === undefined) {
      list = [];
      this.values.set(name, list);
    }
    list.push(ms);
  }

  count(name, by = 1) {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by);
  }

  result() {
    return {
      timings: Object.fromEntries([...this.values].map(([k, v]) => [k, summary(v)])),
      counts: Object.fromEntries(this.counts),
    };
  }
}

export function memorySummary(samples, phase) {
  const list = samples.filter((s) => phase === undefined || s.phase === phase);
  if (list.length === 0) return null;
  const peak = Math.max(...list.map((s) => s.cgroupMb));
  const cpu = summary(list.map((s) => s.cpuCores));
  const third = list.slice(Math.floor((list.length * 2) / 3));
  const slope =
    third.length > 1
      ? (third[third.length - 1].cgroupMb - third[0].cgroupMb) /
        ((third[third.length - 1].at - third[0].at) / 60000)
      : 0;
  const lastGroups = list[list.length - 1].groups;
  return {
    peakMb: Math.round(peak),
    endMb: Math.round(list[list.length - 1].cgroupMb),
    slopeMbPerMin: Math.round(slope * 10) / 10,
    cpuCores: { p50: cpu.p50, p95: cpu.p95, max: cpu.max },
    processes: list[list.length - 1].processes,
    wikiRestarts: (list[list.length - 1].restarts ?? 0) - (list[0].restarts ?? 0),
    groups: lastGroups,
  };
}
