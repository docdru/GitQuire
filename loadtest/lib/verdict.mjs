export const LIMITS = {
  editPropagateP95: 500,
  editPropagateP99: 1500,
  editAckP95: 500,
  pageOpenP95: 1000,
  coldOpenMax: 8000,
  apiP95: 800,
  heavyApiP95: 1500,
  probeWikiP95: 400,
  errorRate: 0.005,
  memoryShare: 0.85,
  saveToHostSeconds: 120,
  publishMax: 15000,
};

const HEAVY = new Set(['api.search', 'api.backlinks', 'api.linkgraph']);

function memoryLimitMb() {
  const text = process.env.LOADTEST_MEMORY ?? '4g';
  const match = /^(\d+(?:\.\d+)?)([gm])$/i.exec(text);
  if (match === null) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * (match[2].toLowerCase() === 'g' ? 1024 : 1);
}

export function evaluate(_scenario, result) {
  const reasons = [];
  if (result.error) return { pass: false, stop: true, reasons: [result.error] };
  const t = result.timings ?? {};
  const c = result.counts ?? {};
  const check = (name, value, limit, label) => {
    if (value !== null && value !== undefined && value > limit)
      reasons.push(`${label} ${value} > ${limit}`);
  };
  check('p', t['edit.propagate']?.p95, LIMITS.editPropagateP95, 'edit propagate p95 ms');
  check('p', t['edit.propagate']?.p99, LIMITS.editPropagateP99, 'edit propagate p99 ms');
  check('a', t['edit.ack']?.p95, LIMITS.editAckP95, 'edit ack p95 ms');
  check('o', t['page.open']?.p95, LIMITS.pageOpenP95, 'page open p95 ms');
  check('c', t['wiki.coldOpen']?.max, LIMITS.coldOpenMax, 'cold open ms');
  check('d', t['draft.open']?.max, LIMITS.coldOpenMax, 'draft first open ms');
  check('d', t['draft.publish']?.max, LIMITS.publishMax, 'publish ms');
  check('w', t['probe.wiki']?.p95, LIMITS.probeWikiP95, 'wiki responsiveness p95 ms');
  for (const [name, s] of Object.entries(t)) {
    if (!name.startsWith('api.')) continue;
    check(name, s.p95, HEAVY.has(name) ? LIMITS.heavyApiP95 : LIMITS.apiP95, `${name} p95 ms`);
  }
  const requests = c.requests ?? 0;
  if (requests > 0 && (c.errors ?? 0) / requests > LIMITS.errorRate) {
    reasons.push(`errors ${c.errors}/${requests}`);
  }
  for (const key of [
    'lost.converge',
    'lost.server',
    'lost.host',
    'diverged.clients',
    'sync.neverReachedHost',
  ]) {
    if ((c[key] ?? 0) > 0) reasons.push(`${key} ${c[key]}`);
  }
  const save = t['sync.saveToHost']?.p95;
  if (
    save !== undefined &&
    save !== null &&
    !String(result.level?.phase ?? '').startsWith('down')
  ) {
    check('s', Math.round(save / 1000), LIMITS.saveToHostSeconds, 'save to host p95 s');
  }
  if ((c['wiki.busy'] ?? 0) > 0)
    reasons.push(`server answered busy: ${result.wikisOpen ?? '?'} wikis open, no room for more`);
  if ((c['draft.busy'] ?? 0) > 0)
    reasons.push(`server answered busy: ${result.draftsInUse ?? '?'} drafts in use, no room for more`);
  if ((c['edit.propagate.timeout'] ?? 0) > 0)
    reasons.push(`edits not seen within 30 s: ${c['edit.propagate.timeout']}`);
  if ((result.memory?.oomKills ?? 0) > 0)
    reasons.push(`processes killed for memory: ${result.memory.oomKills}`);
  if ((result.memory?.wikiRestarts ?? 0) > 0)
    reasons.push(`wiki processes restarted: ${result.memory.wikiRestarts}`);
  const limit = memoryLimitMb();
  if (result.memory?.peakMb > LIMITS.memoryShare * limit) {
    reasons.push(
      `memory ${result.memory.peakMb} MB > ${Math.round(LIMITS.memoryShare * limit)} MB`,
    );
  }
  return { pass: reasons.length === 0, stop: true, reasons };
}
