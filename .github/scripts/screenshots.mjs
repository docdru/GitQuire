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

async function shoot(page, name) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
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
      await shoot(page, `${profile.name}-03-editing`);

      const firstParagraph = page.locator('.ProseMirror p').first();
      await firstParagraph.dblclick().catch(() => undefined);
      await page.waitForTimeout(700);
      await shoot(page, `${profile.name}-04-selection`);
    }

    const sidebarToggle = page.locator('[data-sidebar="trigger"], [aria-label*="sidebar" i]').first();
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
