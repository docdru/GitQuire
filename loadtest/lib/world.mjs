import { performance } from 'node:perf_hooks';
import { base, fakeBase, login, people, startFake, startServer } from './env.mjs';
import { Session } from './session.mjs';

export async function setupWorld({ wikis, persons, serverEnv = {}, open = true }) {
  const levels = {};
  const all = people(persons);
  for (const who of Object.keys(all)) {
    levels[who] = {};
    for (const w of wikis) levels[who][w.name] = who === login(1) ? 'admin' : 'write';
  }
  const repos = wikis.map((w, i) => ({
    id: 700 + i,
    owner: 'team',
    name: w.name,
    seedBare: w.seedBare,
  }));
  await startFake({ repos, persons: all, levels });
  const startMs = await startServer(serverEnv);
  const admin = new Session(base(), fakeBase(), login(1));
  await admin.signIn();
  const world = { admin, startMs, wikis: [], addMs: [], openMs: [] };
  if (wikis.length > 0) {
    const round = await admin.round('/auth/github/add-wiki?next=%2F');
    if (!round.ok) throw new Error(`add-wiki round failed ${JSON.stringify(round)}`);
    for (const [i, w] of wikis.entries()) {
      const added = await addWiki(admin, repos[i].id, w.name);
      world.addMs.push(added.addMs);
      if (open) world.openMs.push(await openWiki(admin, added.path));
      world.wikis.push({ name: w.name, path: added.path, id: repos[i].id });
    }
  }
  return world;
}

export async function addWiki(admin, id, name) {
  const started = performance.now();
  const made = await admin.call('POST', '/api/front-door/wikis', { host: 'github', id });
  if (made.status !== 201)
    throw new Error(`make wiki ${name}: ${made.status} ${made.text.slice(0, 300)}`);
  return { addMs: performance.now() - started, path: made.json.wiki.address };
}

export async function openWiki(session, path) {
  const started = performance.now();
  let last = 0;
  for (let attempt = 0; attempt < 120; attempt++) {
    const res = await session.call('GET', `${path}api/documents`);
    if (res.status === 200) return performance.now() - started;
    last = res.status;
    await new Promise((r) => setTimeout(r, 500));
  }
  const err = new Error(`wiki ${path} did not open (last answer ${last})`);
  err.busy = last === 503;
  throw err;
}

export async function signInMany(count, first = 2) {
  const out = [];
  for (let i = first; i < first + count; i++) {
    const s = new Session(base(), fakeBase(), login(i));
    await s.signIn();
    out.push(s);
  }
  return out;
}

export async function documentNames(session, wikiPath) {
  const res = await session.call('GET', `${wikiPath}api/documents`);
  if (res.status !== 200) throw new Error(`documents ${res.status}`);
  return res.json.documents
    .filter((d) => d.kind === 'document' && !d.docName.startsWith('.') && d.docName !== 'AGENTS')
    .map((d) => d.docName);
}
