import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PROXY = process.env.PROXY_URL ?? 'http://127.0.0.1:9000';
const A = `${PROXY}/w/team/wiki`;
const B = `${PROXY}/w/team/wiki-b`;
const PASSWORD = process.env.BOB_PASSWORD;
const escapes = process.env.PROXY_LOG ?? '/tmp/proxy-escapes.log';
const results = [];

function record(row, passed, detail) {
  results.push({ row, passed, detail });
  const mark = passed === true ? 'PASS' : passed === false ? 'FAIL' : 'INFO';
  console.log(`[${row}] ${mark}: ${detail}`);
}

function disk(container, path) {
  try {
    return execFileSync('docker', ['exec', container, 'cat', `/data/${path}`], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function sh(container, script) {
  try {
    return execFileSync('docker', ['exec', container, 'sh', '-c', script], { encoding: 'utf8' }).trim();
  } catch (err) {
    return `error: ${String(err.stderr ?? err).trim().slice(-200)}`;
  }
}

function escapeLog(since = 0) {
  try {
    return readFileSync(escapes, 'utf8').split('\n').filter(Boolean).slice(since).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const editor = (page) => page.locator('.ProseMirror:not(.composer-prosemirror)').first();
const sidebarItem = (page, name) =>
  page.locator('[data-slot="sidebar-container"]').getByRole('treeitem', { name, exact: true });

async function signIn(page, wikiUrl) {
  await page.goto(`${wikiUrl}/`);
  await page.waitForLoadState('domcontentloaded');
  const steps = [page.url()];
  const at = (path) => /^http:\/\/127\.0\.0\.1:(3000|9001)\//.test(page.url()) && new URL(page.url()).pathname === path;
  if (at('/user/login')) {
    await page.fill('#user_name', 'bob');
    await page.fill('#password', PASSWORD);
    await Promise.all([page.waitForNavigation(), page.locator('form.ui.form button.primary, button.ui.primary.button').first().click()]);
    steps.push(page.url());
  }
  if (at('/login/oauth/authorize')) {
    const grant = page.locator('#authorize-app, button[name="granted"][value="true"]').first();
    await Promise.all([page.waitForNavigation(), grant.click()]);
    steps.push(page.url());
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  steps.push(page.url());
  return steps;
}

async function apiCall(page, path, init) {
  return page.evaluate(
    async ({ path, init }) => {
      const res = await fetch(path, init);
      return { status: res.status, body: await res.text() };
    },
    { path, init },
  );
}

async function openPage(page, wikiUrl, name) {
  await page.goto(`${wikiUrl}/#/${name}`);
  await editor(page).waitFor({ state: 'visible', timeout: 60_000 });
}

async function typeAtEnd(page, text) {
  const area = editor(page);
  await area.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(text);
}

async function poll(fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function p1(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const seen = [];
  page.on('request', (r) => seen.push(`${r.method()} ${r.url()}`));
  page.on('pageerror', (e) => console.log(`[P1] INFO: page error ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[P1] INFO: console error ${m.text().slice(0, 300)}`);
  });
  let steps;
  try {
    steps = await signIn(page, A);
  } catch (err) {
    record('P1', false, `sign-in did not complete: ${String(err).slice(0, 200)}; at ${page.url()}`);
    return { ctx, page, signedIn: false };
  }
  const landed = page.url().startsWith(`${A}/`);
  const diag = await page.evaluate(() => ({ shim: window.__gqProtoShim ?? null, head: document.documentElement.outerHTML.slice(0, 300) }));
  record('P1', null, `diagnostics: shim ${diag.shim}; page starts ${JSON.stringify(diag.head)}`);
  record('P1', null, `first requests: ${JSON.stringify(seen.slice(0, 25))}`);
  record('P1', landed, `sign-in steps ${JSON.stringify(steps)}; landed under the wiki prefix: ${landed}`);
  const me = await apiCall(page, '/auth/me');
  const cookieList = (await ctx.cookies()).map((c) => [c.name, c.path]);
  record('P1', null, `all cookies after sign-in: ${JSON.stringify(cookieList)}`);
  record('P1', me.status === 200 && me.body.includes('bob'), `GET /auth/me through the prefix -> ${me.status} ${me.body.slice(0, 160)}`);
  try {
    await openPage(page, A, 'index');
    record('P1', true, 'page index opens in the editor under the prefix');
  } catch (err) {
    record('P1', false, `page index did not open: ${String(err).slice(0, 160)}`);
    return { ctx, page, signedIn: landed };
  }

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC',
    'base64',
  ).toString('base64');
  const upload = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append('parentDocName', 'index');
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'dot.png');
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    return { status: res.status, body: await res.text() };
  }, png);
  let src = null;
  try {
    src = JSON.parse(upload.body).src ?? JSON.parse(upload.body).data?.src ?? null;
  } catch {}
  record('P1', upload.status === 200 && Boolean(src), `upload an image -> ${upload.status}, src ${src}`);
  if (src) {
    const pagePath = 'index.md';
    const current = disk('gq-a', pagePath);
    execFileSync('docker', ['exec', '-i', 'gq-a', 'sh', '-c', `cat > /data/${pagePath}`], {
      input: `${current.trimEnd()}\n\n![dot](${src})\n`,
    });
    const reread = await apiCall(page, '/api/documents/reread', { method: 'POST' });
    record('P1', null, `wrote the image reference into index.md and asked to re-read -> ${reread.status}`);
    await page.reload();
    await editor(page).waitFor({ state: 'visible' });
    const loaded = await poll(async () => {
      const sizes = await editor(page).locator('img').evaluateAll((imgs) => imgs.map((i) => [i.getAttribute('src'), i.currentSrc, i.naturalWidth]));
      return sizes.length > 0 && sizes.every(([, , w]) => w > 0) ? sizes : null;
    }, 30_000);
    const all = await editor(page).locator('img').evaluateAll((imgs) => imgs.map((i) => [i.getAttribute('src'), i.currentSrc, i.naturalWidth]));
    for (const [, url] of all) {
      const viaProxy = await page.request.get(url).catch((e) => ({ status: () => String(e) }));
      const direct = await page.request.get(url.replace('127.0.0.1:9000', '127.0.0.1:8101')).catch((e) => ({ status: () => String(e) }));
      const prefixed = await page.request.get(url.replace('127.0.0.1:9000/', '127.0.0.1:9000/w/team/wiki/')).catch((e) => ({ status: () => String(e) }));
      record('P1', null, `image ${url}: through the catch-all -> ${viaProxy.status()}, with the prefix -> ${prefixed.status()}, straight to the wiki's process -> ${direct.status()}`);
    }
    record('P1', Boolean(loaded), `uploaded image in the editor: ${JSON.stringify(all)}`);
  }

  const other = await ctx.newPage();
  const sentinel = `Live edit ${Date.now()}`;
  try {
    await openPage(other, A, 'index');
    await typeAtEnd(page, sentinel);
    const live = await poll(async () => ((await editor(other).innerText()).includes(sentinel) ? true : null), 20_000);
    record('P1', Boolean(live), `second tab sees the typed text live: ${Boolean(live)}`);
    const saved = await poll(async () => (disk('gq-a', 'index.md').includes(sentinel) ? true : null), 30_000);
    record('P1', Boolean(saved), `typed text reached /data/index.md: ${Boolean(saved)}`);
  } catch (err) {
    record('P1', false, `live editing: ${String(err).slice(0, 200)}`);
  }
  await other.close();

  const created = await apiCall(page, '/api/gitquire/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Prototype draft' }),
  });
  let slug = null;
  try {
    slug = JSON.parse(created.body).draft?.slug ?? null;
  } catch {}
  record('P1', created.status === 201 && Boolean(slug), `create and open a draft -> ${created.status} ${created.body.slice(0, 160)}`);
  if (slug) {
    await page.reload();
    const cookies = await ctx.cookies(PROXY);
    record('P1', null, `cookies after opening the draft: ${JSON.stringify(cookies.map((c) => [c.name, c.path]))}`);
    const draftText = `Draft edit ${Date.now()}`;
    try {
      await openPage(page, A, 'index');
      const current = await apiCall(page, '/api/gitquire/drafts/current');
      record('P1', current.body.includes(slug), `inside the draft after reload: ${current.status} ${current.body.slice(0, 120)}`);
      await typeAtEnd(page, draftText);
      await new Promise((r) => setTimeout(r, 8000));
      const changes = await apiCall(page, `/api/gitquire/drafts/${slug}/changes`);
      const inLive = disk('gq-a', 'index.md').includes(draftText);
      record('P1', !inLive && changes.body.includes('index'), `draft edit stays out of the live wiki: ${!inLive}; draft changes ${changes.status} ${changes.body.slice(0, 160)}`);
    } catch (err) {
      record('P1', false, `editing inside the draft: ${String(err).slice(0, 200)}`);
    }
    const left = await apiCall(page, '/api/gitquire/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: null }),
    });
    await page.reload();
    await openPage(page, A, 'index');
    const after = await apiCall(page, '/api/gitquire/drafts/current');
    record('P1', left.status === 200 && after.body.includes('"viewing":null'), `leave the draft -> ${left.status}; current ${after.body.slice(0, 120)}`);
  }
  return { ctx, page, signedIn: landed, slug };
}

async function p2(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, A);
  await signIn(page, B);
  await openPage(page, A, 'index');
  await new Promise((r) => setTimeout(r, 3000));
  const offlineText = `Offline in A ${Date.now()}`;
  await ctx.setOffline(true);
  await typeAtEnd(page, offlineText);
  await new Promise((r) => setTimeout(r, 3000));
  await page.close();
  await ctx.setOffline(false);
  const pageB = await ctx.newPage();
  await openPage(pageB, B, 'index');
  await new Promise((r) => setTimeout(r, 12_000));
  const inBDisk = disk('gq-b', 'index.md').includes(offlineText);
  const inBEditor = (await editor(pageB).innerText()).includes(offlineText);
  record('P2', !inBDisk && !inBEditor, `offline edit of A after switching to B: in B's file ${inBDisk}, in B's editor ${inBEditor}`);
  const tabsKey = (await pageB.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ok-editor-tabs')))) ?? [];
  for (const key of tabsKey) {
    record('P2', null, `${key} after visiting A then B: ${(await pageB.evaluate((k) => localStorage.getItem(k), key))?.slice(0, 400)}`);
  }
  const syncA = await apiCall(pageB, `${A}/api/sync/status`);
  record('P3', null, `sync status of A: ${syncA.status} ${syncA.body.slice(0, 500)}`);
  const storage = await pageB.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    idb: (await indexedDB.databases?.())?.map((d) => d.name) ?? [],
  }));
  record('P2', null, `browser storage shared by both wikis on one origin: ${JSON.stringify(storage).slice(0, 900)}`);
  const pageA = await ctx.newPage();
  await openPage(pageA, A, 'index');
  const kept = await poll(async () => (disk('gq-a', 'index.md').includes(offlineText) ? true : null), 30_000);
  record('P2', null, `offline edit reached A after reopening A: ${Boolean(kept)}`);
  const bText = await editor(pageB).innerText();
  record('P2', !bText.includes('Wiki A'), `B's page shows only B's content: ${!bText.includes('Wiki A')}`);
  await ctx.close();
}

const browser = await chromium.launch();
const start = escapeLog().length;
try {
  await p1(browser);
} catch (err) {
  record('P1', false, `stopped: ${String(err).slice(0, 300)}`);
}
try {
  await p2(browser);
} catch (err) {
  record('P2', false, `stopped: ${String(err).slice(0, 300)}`);
}
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, A);
  await openPage(page, A, 'index');
  const p3 = `P3 last edit ${Date.now()}`;
  await typeAtEnd(page, p3);
  await new Promise((r) => setTimeout(r, 2500));
  appendFileSync('/tmp/p3-sentinel.txt', p3);
  record('P3', null, `typed "${p3}" in A 2.5 s before the stop; on disk at that moment: ${disk('gq-a', 'index.md').includes(p3)}`);
} catch (err) {
  record('P3', false, `could not prepare the last edit: ${String(err).slice(0, 200)}`);
}
await browser.close();

const log = escapeLog(start);
const kinds = {};
for (const entry of log) {
  const key = `${entry.kind} ${entry.method} ${entry.url.split('?')[0]}`;
  kinds[key] = (kinds[key] ?? 0) + 1;
}
record('P1', null, `requests that arrived without a wiki prefix: ${JSON.stringify(kinds)}`);

const lines = ['### GitQuire prototype rows P1-P2', '', '| Row | Result | Detail |', '| --- | --- | --- |'];
for (const { row, passed, detail } of results) {
  lines.push(`| ${row} | ${passed === true ? 'pass' : passed === false ? '**fail**' : 'note'} | ${detail.replaceAll('|', '/')} |`);
}
const summary = `${lines.join('\n')}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
