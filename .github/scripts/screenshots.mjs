import { mkdir } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

const base = process.env.GITQUIRE_URL ?? 'http://127.0.0.1:8080';
const out = process.env.SCREENSHOT_DIR ?? 'screenshots';
const doc = process.env.SCREENSHOT_DOC ?? 'welcome';

const profiles = [
  { name: 'phone', options: { ...devices['iPhone 14'] } },
  { name: 'phone-landscape', options: { ...devices['iPhone 14 landscape'] } },
  { name: 'tablet', options: { ...devices['iPad Mini'] } },
  { name: 'desktop', options: { viewport: { width: 1280, height: 800 } } },
];

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
}

const printToLog = process.env.SCREENSHOT_LOG === '1';

async function shoot(page, name) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  if (printToLog) {
    const small = await page.screenshot({ type: 'jpeg', quality: 45, scale: 'css' });
    console.log(`::group::screenshot ${name}`);
    console.log(`SCREENSHOT-BEGIN ${name}`);
    console.log(small.toString('base64'));
    console.log(`SCREENSHOT-END ${name}`);
    console.log('::endgroup::');
  }
  console.log(`captured ${name}`);
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const failures = [];
for (const profile of profiles) {
  const context = await browser.newContext(profile.options);
  const page = await context.newPage();
  page.on('pageerror', (err) => failures.push(`${profile.name}: ${err.message}`));
  try {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await shoot(page, `${profile.name}-01-home`);

    await page.goto(`${base}/#/${doc}`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await shoot(page, `${profile.name}-02-document`);

    const editor = page.locator('.ProseMirror').first();
    if (await editor.isVisible().catch(() => false)) {
      await editor.click({ position: { x: 40, y: 20 } }).catch(() => undefined);
      await page.waitForTimeout(500);
      const probe = await page.evaluate(() => ({
        coarse: window.matchMedia('(pointer: coarse)').matches,
        focusedEditor: document.activeElement?.closest('.ProseMirror') !== null,
        touchToolbar: document.querySelector('[data-testid="touch-edit-toolbar"]') !== null,
      }));
      console.log(`${profile.name} editing probe: ${JSON.stringify(probe)}`);
      await shoot(page, `${profile.name}-03-editing`);

      await page.evaluate(() => {
        const paragraph = document.querySelector('.ProseMirror p');
        const text = paragraph?.firstChild;
        if (!text) return;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, Math.min(14, text.textContent?.length ?? 0));
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await page.mouse.up().catch(() => undefined);
      await page.waitForTimeout(900);
      await shoot(page, `${profile.name}-04-selection`);
    }

    const sidebarToggle = page.locator('[data-sidebar="trigger"]:visible').first();
    if (await sidebarToggle.isVisible().catch(() => false)) {
      await sidebarToggle.click().catch(() => undefined);
      await page.waitForTimeout(700);
      await shoot(page, `${profile.name}-05-sidebar`);
    }
  } catch (err) {
    failures.push(`${profile.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await context.close();
}
await browser.close();

if (failures.length > 0) {
  console.log('Page errors and failures:');
  for (const failure of failures) console.log(`- ${failure}`);
}
