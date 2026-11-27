import { createRequire } from 'node:module';
import { join } from 'node:path';

export async function launchBrowser() {
  const dir = process.env.LOADTEST_PLAYWRIGHT_DIR ?? '/tmp/pw';
  const require = createRequire(join(dir, 'package.json'));
  const { chromium } = require('playwright');
  const executablePath = process.env.LOADTEST_CHROME || undefined;
  return chromium.launch({ headless: true, executablePath });
}

export async function signedInPage(browser, session) {
  const context = await browser.newContext({ baseURL: session.base });
  const url = new URL(session.base);
  await context.addCookies(
    [...session.cookies].map(([name, value]) => ({
      name,
      value,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    })),
  );
  const page = await context.newPage();
  const console = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/ok-buffer-replay|ok-pool-restart|ok-pool-mismatch|diverged|refused/i.test(text))
      console.push(text.slice(0, 300));
  });
  return { context, page, console };
}

export function editorOf(page) {
  return page.locator('.ProseMirror:not(.composer-prosemirror)').first();
}
