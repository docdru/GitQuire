import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { hostFile } from './env.mjs';

export async function converged(editors, markers, timeoutMs = 20_000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const texts = editors.map((e) => e.plain());
    const same = texts.every((t) => t === texts[0]);
    const missing = markers.filter((m) => !texts[0].includes(m));
    if (same && missing.length === 0) return { ok: true, ms: performance.now() - started };
    await wait(500);
  }
  const texts = editors.map((e) => e.plain());
  return {
    ok: false,
    differing: texts.filter((t) => t !== texts[0]).length,
    missing: markers.filter((m) => !texts[0].includes(m)).length,
  };
}

export async function onServer(session, wikiPath, docName, markers, timeoutMs = 30_000) {
  const started = performance.now();
  let missing = markers;
  while (performance.now() - started < timeoutMs) {
    const res = await session.call(
      'GET',
      `${wikiPath}api/document?docName=${encodeURIComponent(docName)}`,
    );
    const content = res.json?.content ?? '';
    missing = markers.filter((m) => !content.includes(m));
    if (missing.length === 0) {
      const doubled = markers.filter((m) => content.split(m).length > 2).length;
      return { ok: true, ms: performance.now() - started, doubled };
    }
    await wait(1000);
  }
  return { ok: false, missing: missing.length, doubled: 0 };
}

export async function onHost(session, wikiPath, repo, docName, markers, timeoutMs = 180_000) {
  const started = performance.now();
  await session.call('POST', `${wikiPath}api/sync/trigger`, {});
  let missing = markers;
  while (performance.now() - started < timeoutMs) {
    const content = hostFile(repo, `${docName}.md`);
    missing = markers.filter((m) => !content.includes(m));
    if (missing.length === 0) return { ok: true, ms: performance.now() - started };
    await wait(2000);
  }
  return { ok: false, missing: missing.length };
}
