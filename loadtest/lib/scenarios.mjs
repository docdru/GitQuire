import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { converged, onHost, onServer } from './checks.mjs';
import { fakeControl, hostFile, serverLogs, settings, stopFake, stopServer } from './env.mjs';
import { generateBareRepo, pagePath } from './generate.mjs';

const page = (i) => pagePath(i, 10);
import { MarkerBoard, Reader, Typist } from './people.mjs';
import { Sampler } from './sampler.mjs';
import { memorySummary, Recorder } from './stats.mjs';
import { documentNames, openWiki, setupWorld, signInMany } from './world.mjs';

function seedRepo(pages, commits) {
  const target = join(settings.work, 'seeds', `w-${pages}-${commits}.git`);
  if (!existsSync(join(target, 'HEAD')))
    generateBareRepo(target, { pages, commits, seed: pages + commits });
  return target;
}

function probes(target, admin, wikiPaths) {
  let stopped = false;
  let last = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const recorder = typeof target === 'function' ? target() : target;
    recorder.add('client.lag', Math.max(0, now - last - 20));
    last = now;
  }, 20);
  const loop = async () => {
    while (!stopped) {
      const recorder = typeof target === 'function' ? target() : target;
      const started = performance.now();
      try {
        const res = await fetch(`${admin.base}/readyz`);
        await res.text();
        recorder.add('probe.door', performance.now() - started);
      } catch {
        recorder.count('probe.door.failed');
      }
      for (const path of wikiPaths()) {
        const res = await admin.call('GET', `${path}api/sync/status`).catch(() => undefined);
        if (res?.status === 200) recorder.add('probe.wiki', res.ms);
        else recorder.count('probe.wiki.failed');
      }
      await wait(2000);
    }
  };
  const running = loop();
  return async () => {
    clearInterval(lagTimer);
    stopped = true;
    await running;
  };
}

async function startProfiler(wiki) {
  const { profileWanted, StallProfiler } = await import('./stalls.mjs');
  if (!profileWanted()) return undefined;
  const profiler = new StallProfiler({ key: `github-${wiki.id}` });
  try {
    await profiler.start();
    return profiler;
  } catch (err) {
    console.log(`[loadtest] stall profile not started: ${err.message ?? err}`);
    return undefined;
  }
}

async function finish(world, sampler, stopProbes) {
  await stopProbes();
  const samples = sampler.stop();
  return samples;
}

async function teardown() {
  const counts = new Map();
  for (const line of serverLogs(20000).split('\n')) {
    if (!/WARN|ERROR|FATAL|exited|killed|out of memory|heap/i.test(line)) continue;
    const key = line
      .replace(/^\[[0-9:]+\] /, '')
      .replace(/pid=\d+/g, 'pid=N')
      .slice(0, 200);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size > 0) {
    const list = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40);
    console.log(
      `[loadtest] server warnings and errors:\n${list.map(([k, n]) => `${String(n).padStart(6)} × ${k}`).join('\n')}`,
    );
  }
  await stopServer();
  await stopFake();
}

async function mixedLoad({
  world,
  wiki,
  sessions,
  recorder,
  until,
  editorShare = 0.2,
  seed = 1,
  hubs = [],
}) {
  const docNames = await documentNames(world.admin, wiki.path);
  const typists = [];
  const readers = [];
  const editorCount = Math.max(1, Math.round(sessions.length * editorShare));
  sessions.forEach((session, i) => {
    if (i < editorCount) {
      typists.push(
        new Typist({
          session,
          wikiPath: wiki.path,
          docName: docNames[(i * 7919) % docNames.length],
          recorder,
          seed: seed * 1000 + i,
        }),
      );
    } else {
      readers.push(
        new Reader({
          session,
          wikiPath: wiki.path,
          docNames,
          recorder,
          seed: seed * 1000 + i,
          hubs,
        }),
      );
    }
  });
  for (const t of typists) await t.open();
  const runs = [...typists.map((t) => t.run(until)), ...readers.map((r) => r.run(until))];
  return {
    typists,
    readers,
    done: async () => {
      await Promise.all(runs);
      const checks = [];
      for (const t of typists) {
        checks.push(await onServer(world.admin, wiki.path, t.docName, t.markers, 90_000));
      }
      for (const t of typists) t.close();
      const lost = checks.filter((c) => !c.ok).reduce((n, c) => n + c.missing, 0);
      recorder.count('lost.server', lost);
      return { typists, checks };
    },
  };
}

export const scenarios = {
  s0: {
    title: 'Idle footprint',
    levels: (quick) => (quick ? [100] : [100, 5000]),
    async run(pages, { hold }) {
      const recorder = new Recorder();
      const seedBare = seedRepo(pages, Math.min(pages, 1000));
      const sampler = new Sampler(2000);
      const world = await setupWorld({
        wikis: [{ name: 'idle', seedBare }],
        persons: 1,
        open: false,
        serverEnv: { GITQUIRE_WIKI_IDLE_MINUTES: '0.5' },
      });
      sampler.start();
      sampler.mark('no-wiki-open');
      await wait(15_000);
      sampler.mark('one-wiki-open');
      const openMs = await openWiki(world.admin, world.wikis[0].path);
      await wait(Math.min(hold, 60_000));
      sampler.mark('asleep');
      await world.admin.call('POST', `${world.wikis[0].path}api/sync/trigger`, {});
      const key = `wiki:github-${world.wikis[0].id}`;
      const sleepStarted = Date.now();
      while (Date.now() - sleepStarted < 240_000) {
        const sample = sampler.take();
        if (sample !== undefined && sample.groups[key] === undefined) break;
        await wait(2000);
      }
      const asleep = Date.now() - sleepStarted < 240_000;
      const wakeMs = asleep ? await openWiki(world.admin, world.wikis[0].path) : null;
      const samples = sampler.stop();
      await teardown();
      return {
        level: { pages },
        startMs: world.startMs,
        addMs: world.addMs[0],
        firstOpenMs: openMs,
        wakeMs,
        memoryNoWiki: memorySummary(samples, 'no-wiki-open'),
        memory: memorySummary(samples, 'one-wiki-open'),
        ...recorder.result(),
      };
    },
  },

  s1: {
    title: 'One page, many editors',
    levels: (quick) => (quick ? [2, 10] : [2, 5, 10, 20, 40]),
    async run(editors, { hold, seed }) {
      const recorder = new Recorder();
      const seedBare = seedRepo(100, 100);
      const world = await setupWorld({
        wikis: [{ name: 'meeting', seedBare }],
        persons: editors + 1,
      });
      const wiki = world.wikis[0];
      const sampler = new Sampler();
      sampler.start();
      const stopProbes = probes(recorder, world.admin, () => [wiki.path]);
      const docName = page(10);
      const board = new MarkerBoard(recorder);
      const { Editor } = await import('./editor.mjs');
      const observer = new Editor(world.admin, wiki.path, docName);
      await observer.synced();
      board.watch(observer);
      const sessions = await signInMany(editors);
      const typists = sessions.map(
        (session, i) =>
          new Typist({
            session,
            wikiPath: wiki.path,
            docName,
            recorder,
            board,
            seed: seed * 100 + i,
          }),
      );
      for (const t of typists) await t.open();
      const until = Date.now() + hold;
      const expiry = setInterval(() => board.expire(), 5000);
      await Promise.all(typists.map((t) => t.run(until)));
      clearInterval(expiry);
      await wait(3000);
      board.expire(0);
      const markers = typists.flatMap((t) => t.markers);
      const together = await converged([observer, ...typists.map((t) => t.editor)], markers);
      const server = await onServer(world.admin, wiki.path, docName, markers);
      const host = await onHost(world.admin, wiki.path, wiki.name, docName, markers);
      const samples = await finish(world, sampler, stopProbes);
      const disconnects = typists.reduce((n, t) => n + t.editor.disconnects, 0);
      for (const t of typists) t.close();
      observer.destroy();
      await teardown();
      recorder.count('markers', markers.length);
      recorder.count('disconnects', disconnects);
      recorder.count('lost.converge', together.ok ? 0 : together.missing);
      recorder.count('diverged.clients', together.ok ? 0 : together.differing);
      recorder.count('lost.server', server.ok ? 0 : server.missing);
      recorder.count('lost.host', host.ok ? 0 : host.missing);
      return {
        level: { editors },
        saveToHostMs: host.ms,
        memory: memorySummary(samples),
        ...recorder.result(),
      };
    },
  },

  s2: {
    title: 'One wiki, normal day',
    levels: (quick) => (quick ? [10, 25] : [10, 25, 50, 100]),
    async run(people, { hold, seed }) {
      const recorder = new Recorder();
      const seedBare = seedRepo(1000, 1000);
      const world = await setupWorld({ wikis: [{ name: 'team', seedBare }], persons: people + 1 });
      const wiki = world.wikis[0];
      const profiler = await startProfiler(wiki);
      const sampler = new Sampler();
      sampler.start();
      const stopProbes = probes(recorder, world.admin, () => [wiki.path]);
      const sessions = await signInMany(people);
      const load = await mixedLoad({
        world,
        wiki,
        sessions,
        recorder,
        until: Date.now() + hold,
        seed,
        hubs: [0, 1, 2].map(page),
      });
      await load.done();
      const stalls = await profiler?.stop();
      const samples = await finish(world, sampler, stopProbes);
      await teardown();
      return {
        level: { people },
        memory: memorySummary(samples),
        ...(stalls === undefined ? {} : { stalls }),
        ...recorder.result(),
      };
    },
  },

  s3: {
    title: 'Big wiki',
    levels: (quick) =>
      quick
        ? [{ pages: 1000, commits: 1000 }]
        : [
            { pages: 1000, commits: 1000 },
            { pages: 5000, commits: 5000 },
            { pages: 20000, commits: 20000 },
          ],
    async run({ pages, commits }, { hold, seed }) {
      const recorder = new Recorder();
      const genStarted = performance.now();
      const seedBare = seedRepo(pages, commits);
      const genMs = performance.now() - genStarted;
      const sampler = new Sampler();
      const world = await setupWorld({ wikis: [{ name: 'big', seedBare }], persons: 11 });
      sampler.start();
      const wiki = world.wikis[0];
      const profiler = await startProfiler(wiki);
      const hub = page(1);
      const readyStarted = performance.now();
      let backlinksReady = null;
      while (performance.now() - readyStarted < 600_000) {
        const res = await world.admin.call(
          'GET',
          `${wiki.path}api/backlinks?docName=${encodeURIComponent(hub)}`,
        );
        const count = res.json?.backlinks?.length ?? 0;
        if (res.status === 200 && count >= Math.min(199, pages - 1)) {
          backlinksReady = performance.now() - readyStarted;
          break;
        }
        await wait(1000);
      }
      const stopProbes = probes(recorder, world.admin, () => [wiki.path]);
      const sessions = await signInMany(10);
      const load = await mixedLoad({
        world,
        wiki,
        sessions,
        recorder,
        until: Date.now() + hold,
        seed,
        hubs: [0, 2, 3].map(page),
      });
      const renameStarted = performance.now();
      const renamed = await world.admin.call('POST', `${wiki.path}api/rename-path`, {
        kind: 'file',
        fromPath: `${hub}.md`,
        toPath: `${hub} renamed.md`,
      });
      const renameMs = performance.now() - renameStarted;
      recorder.count(`rename.status.${renamed.status}`);
      await load.done();
      let afterCount = 0;
      let afterMs = null;
      const afterStarted = performance.now();
      while (performance.now() - afterStarted < 120_000) {
        const after = await world.admin.call(
          'GET',
          `${wiki.path}api/backlinks?docName=${encodeURIComponent(`${hub} renamed`)}`,
        );
        afterCount = after.json?.backlinks?.length ?? 0;
        if (afterCount >= Math.min(199, pages - 1)) {
          afterMs = performance.now() - renameStarted;
          break;
        }
        await wait(1000);
      }
      const stalls = await profiler?.stop();
      const samples = await finish(world, sampler, stopProbes);
      await teardown();
      return {
        ...(stalls === undefined ? {} : { stalls }),
        level: { pages, commits },
        generateMs: Math.round(genMs),
        addMs: world.addMs[0],
        firstOpenMs: world.openMs[0],
        backlinksReadyMs: backlinksReady,
        renameHubMs: Math.round(renameMs),
        renameStatus: renamed.status,
        renameRewrites:
          renamed.json?.rewrittenDocs?.length ?? renamed.json?.rewritten?.length ?? null,
        backlinksAfterRename: afterCount,
        backlinksAfterRenameMs: afterMs === null ? null : Math.round(afterMs),
        memory: memorySummary(samples),
        ...recorder.result(),
      };
    },
  },

  s4: {
    title: 'Many wikis',
    cumulative: true,
    levels: (quick) => (quick ? [1, 5] : [1, 5, 10, 20, 40]),
    async runAll(levels, { hold, seed, sink }) {
      const max = Math.max(...levels);
      const seedBare = seedRepo(200, 200);
      const wikis = Array.from({ length: max }, (_, i) => ({
        name: `wiki${String(i + 1).padStart(2, '0')}`,
        seedBare,
      }));
      const world = await setupWorld({ wikis, persons: max * 3 + 1, open: false });
      const sampler = new Sampler();
      sampler.start();
      const open = [];
      let recorder = new Recorder();
      const stopProbes = probes(
        () => recorder,
        world.admin,
        () => open.map((w) => w.path),
      );
      const results = sink;
      const loads = [];
      let nextLogin = 2;
      for (const count of levels) {
        recorder = new Recorder();
        sampler.mark(`wikis-${count}`);
        while (open.length < count) {
          const wiki = world.wikis[open.length];
          recorder.add('wiki.coldOpen', await openWiki(world.admin, wiki.path));
          open.push(wiki);
          const sessions = await signInMany(3, nextLogin);
          nextLogin += 3;
          loads.push({
            wiki,
            sessions,
          });
        }
        const until = Date.now() + hold;
        const running = [];
        for (const { wiki, sessions } of loads) {
          running.push(
            mixedLoad({ world, wiki, sessions, recorder, until, editorShare: 0.34, seed }),
          );
        }
        const started = await Promise.all(running);
        const listStarted = performance.now();
        const list = await world.admin.call('GET', '/api/front-door/wikis');
        recorder.add('door.wikiList', performance.now() - listStarted);
        recorder.count(`door.wikiList.status.${list.status}`);
        await Promise.all(started.map((s) => s.done()));
        const memory = memorySummary(sampler.samples, `wikis-${count}`);
        results.push({ level: { wikis: count }, memory, ...recorder.result() });
        if (memory !== null && memory.peakMb > 0.95 * parseMemory(settings.memory)) break;
      }
      await stopProbes();
      sampler.stop();
      await teardown();
      return results;
    },
  },

  s5: {
    title: 'Drafts',
    cumulative: true,
    levels: (quick) => (quick ? [1, 3] : [1, 5, 10, 20]),
    async runAll(levels, { hold, seed, sink }) {
      const max = Math.max(...levels);
      const seedBare = seedRepo(200, 200);
      const world = await setupWorld({ wikis: [{ name: 'drafts', seedBare }], persons: max + 6 });
      const wiki = world.wikis[0];
      const docNames = await documentNames(world.admin, wiki.path);
      const sampler = new Sampler();
      sampler.start();
      let recorder = new Recorder();
      const stopProbes = probes(
        () => recorder,
        world.admin,
        () => [wiki.path],
      );
      const liveSessions = await signInMany(5, 2);
      const drafters = [];
      let nextLogin = 7;
      const results = sink;
      for (const count of levels) {
        recorder = new Recorder();
        sampler.mark(`drafts-${count}`);
        while (drafters.length < count) {
          const [session] = await signInMany(1, nextLogin++);
          const createStarted = performance.now();
          const made = await session.call('POST', `${wiki.path}api/gitquire/drafts`, {
            title: `Load draft ${drafters.length + 1}`,
          });
          recorder.add('draft.create', performance.now() - createStarted);
          if (made.status !== 201) {
            recorder.count(`error.draft.create.${made.status}`);
            break;
          }
          drafters.push({
            session,
            slug: made.json.draft.slug,
            docName: docNames[(drafters.length * 31 + 5) % docNames.length],
          });
        }
        const until = Date.now() + hold;
        const live = await mixedLoad({
          world,
          wiki,
          sessions: liveSessions,
          recorder,
          until,
          editorShare: 0.6,
          seed,
        });
        const typists = [];
        for (const d of drafters) {
          const t = new Typist({
            session: d.session,
            wikiPath: wiki.path,
            docName: d.docName,
            recorder,
            seed: seed + typists.length,
          });
          const opened = performance.now();
          await t.open();
          recorder.add('draft.open', performance.now() - opened);
          typists.push(t);
        }
        await Promise.all(typists.map((t) => t.run(until)));
        await live.done();
        await wait(3000);
        for (const t of typists) t.close();
        const memory = memorySummary(sampler.samples, `drafts-${count}`);
        results.push({ level: { drafts: count }, memory, ...recorder.result() });
        if (memory !== null && memory.peakMb > 0.95 * parseMemory(settings.memory)) break;
      }
      const recorderPublish = recorder;
      const target = drafters[0];
      if (target !== undefined) {
        const markers = [];
        const editor = new Typist({
          session: target.session,
          wikiPath: wiki.path,
          docName: target.docName,
          recorder: recorderPublish,
          seed,
        });
        await editor.open();
        const marker = `zqpublish${seed}q`;
        editor.keystroke(` ${marker} `);
        markers.push(marker);
        await wait(3000);
        editor.close();
        const started = performance.now();
        const published = await target.session.call(
          'POST',
          `${wiki.path}api/gitquire/drafts/${target.slug}/publish`,
          {},
        );
        recorderPublish.add('draft.publish', performance.now() - started);
        recorderPublish.count(`draft.publish.status.${published.status}`);
        const server = await onServer(world.admin, wiki.path, target.docName, markers);
        const host = await onHost(world.admin, wiki.path, wiki.name, target.docName, markers);
        recorderPublish.count('lost.server', server.ok ? 0 : server.missing);
        recorderPublish.count('lost.host', host.ok ? 0 : host.missing);
        results[results.length - 1] = {
          ...results[results.length - 1],
          ...recorderPublish.result(),
        };
      }
      await stopProbes();
      sampler.stop();
      await teardown();
      return results;
    },
  },

  s6: {
    title: 'Git under load',
    cumulative: true,
    levels: () => ['delay-0', 'delay-500', 'delay-3000', 'down-120'],
    async runAll(levels, { hold, seed, sink }) {
      const seedBare = seedRepo(1000, 1000);
      const world = await setupWorld({ wikis: [{ name: 'gitload', seedBare }], persons: 26 });
      const wiki = world.wikis[0];
      const sampler = new Sampler();
      sampler.start();
      const results = sink;
      let recorder = new Recorder();
      const stopProbes = probes(
        () => recorder,
        world.admin,
        () => [wiki.path],
      );
      const sessions = await signInMany(25);
      const { Editor } = await import('./editor.mjs');
      const probeDoc = page(7);
      const probe = new Editor(world.admin, wiki.path, probeDoc);
      await probe.synced();
      probe.typeParagraph('sync probe ');
      for (const phase of levels) {
        recorder = new Recorder();
        sampler.mark(phase);
        const [kind, value] = phase.split('-');
        if (kind === 'delay') await fakeControl('delay', { ms: Number(value) });
        const until = Date.now() + hold;
        const load = await mixedLoad({ world, wiki, sessions, recorder, until, seed });
        const pending = [];
        let n = 0;
        let downAt;
        const syncLoop = (async () => {
          while (Date.now() < until) {
            if (kind === 'down' && downAt === undefined && Date.now() > until - hold + 10_000) {
              downAt = Date.now();
              await fakeControl('down', { down: true });
              setTimeout(() => fakeControl('down', { down: false }), Number(value) * 1000).unref();
            }
            const marker = `zqsync${phase.replace('-', '')}x${n++}q`;
            probe.appendToLast(` ${marker} `);
            pending.push({ marker, at: Date.now() });
            await wait(20_000);
          }
        })();
        const hostLoop = (async () => {
          while (Date.now() < until + 240_000 && (Date.now() < until || pending.length > 0)) {
            const content = hostFile(wiki.name, `${probeDoc}.md`);
            for (let i = pending.length - 1; i >= 0; i--) {
              if (content.includes(pending[i].marker)) {
                recorder.add('sync.saveToHost', Date.now() - pending[i].at);
                pending.splice(i, 1);
              }
            }
            await wait(1000);
          }
          recorder.count('sync.neverReachedHost', pending.length);
        })();
        await syncLoop;
        await load.done();
        await hostLoop;
        await fakeControl('down', { down: false });
        await fakeControl('delay', { ms: 0 });
        results.push({
          level: { phase },
          memory: memorySummary(sampler.samples, phase),
          ...recorder.result(),
        });
      }
      probe.destroy();
      await stopProbes();
      sampler.stop();
      await teardown();
      return results;
    },
  },

  s9: {
    title: 'Soak',
    levels: () => [Number(process.env.LOADTEST_SOAK_PEOPLE ?? '20')],
    async run(people, { seed }) {
      const minutes = Number(process.env.LOADTEST_SOAK_MINUTES ?? '60');
      const recorder = new Recorder();
      const seedBare = seedRepo(1000, 1000);
      const world = await setupWorld({ wikis: [{ name: 'soak', seedBare }], persons: people + 1 });
      const wiki = world.wikis[0];
      const sampler = new Sampler(15_000);
      sampler.start();
      const stopProbes = probes(recorder, world.admin, () => [wiki.path]);
      const sessions = await signInMany(people);
      const load = await mixedLoad({
        world,
        wiki,
        sessions,
        recorder,
        until: Date.now() + minutes * 60_000,
        seed,
      });
      await load.done();
      const samples = await finish(world, sampler, stopProbes);
      await teardown();
      return {
        level: { people, minutes },
        memory: memorySummary(samples),
        memoryCurve: samples
          .filter((_, i) => i % 4 === 0)
          .map((s) => [Math.round((s.at - samples[0].at) / 60000), Math.round(s.cgroupMb)]),
        ...recorder.result(),
      };
    },
  },
};

function parseMemory(text) {
  const match = /^(\d+(?:\.\d+)?)([gm])$/i.exec(text);
  if (match === null) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * (match[2].toLowerCase() === 'g' ? 1024 : 1);
}

export { serverLogs };
