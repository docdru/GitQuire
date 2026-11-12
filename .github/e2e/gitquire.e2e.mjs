import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const container = process.env.GITQUIRE_CONTAINER ?? 'gq-e2e';
const dataDir = '/data';

function inContainer(...args) {
  return execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8' });
}

function existsOnDisk(path) {
  try {
    inContainer('test', '-e', `${dataDir}/${path}`);
    return true;
  } catch {
    return false;
  }
}

function readOnDisk(path) {
  try {
    return inContainer('cat', `${dataDir}/${path}`);
  } catch {
    return '';
  }
}

function sidebar(page) {
  return page.locator('[data-slot="sidebar-container"]');
}

function treeItem(page, name) {
  return sidebar(page).getByRole('treeitem', { name, exact: true });
}

function editor(page) {
  return page.locator('.ProseMirror:not(.composer-prosemirror)').first();
}

async function openApp(page, hash = '') {
  await page.goto(`/${hash}`);
  await expect(treeItem(page, 'welcome.md')).toBeVisible();
}

async function typeAtEnd(page, text) {
  const area = editor(page);
  await expect(area).toBeVisible();
  await area.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(text);
  await expect(area).toContainText(text);
}

async function describeState(page, label) {
  const items = await sidebar(page).getByRole('treeitem').allInnerTexts();
  const files = inContainer('ls', '-A', dataDir).split('\n').filter(Boolean);
  console.log(`${label}: tree=${JSON.stringify(items)} disk=${JSON.stringify(files)}`);
}

async function renameNewItem(page, placeholder, name) {
  const input = page.getByRole('textbox', { name: new RegExp(`rename ${placeholder}`, 'i') });
  await expect(input).toBeVisible();
  await input.fill(name);
  const response = page.waitForResponse(
    (res) => res.url().endsWith('/api/rename-path') && res.request().method() === 'POST',
  );
  await input.press('Enter');
  return response;
}

test('a new page can be named right away', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const response = await renameNewItem(page, 'Untitled', 'Meeting Notes');
  const body = await response.text();
  console.log(`rename page: ${response.request().postData()} -> ${response.status()} ${body}`);
  expect(response.status(), body).toBe(200);
  await page.waitForTimeout(3000);
  await describeState(page, 'after page rename');

  await expect(treeItem(page, 'meeting-notes.md')).toBeVisible();
  await expect.poll(() => existsOnDisk('meeting-notes.md')).toBe(true);
  expect(existsOnDisk('untitled.md')).toBe(false);
  expect(existsOnDisk('Untitled.md')).toBe(false);
});

test('a new folder can be named right away', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const response = await renameNewItem(page, 'New Folder', 'Project Plans');
  const body = await response.text();
  console.log(`rename folder: ${response.request().postData()} -> ${response.status()} ${body}`);
  expect(response.status(), body).toBe(200);
  await page.waitForTimeout(3000);
  await describeState(page, 'after folder rename');

  await expect(treeItem(page, 'project-plans')).toBeVisible();
  await expect.poll(() => existsOnDisk('project-plans')).toBe(true);
  expect(existsOnDisk('new-folder')).toBe(false);
});

test('typed text reaches the file and survives a reload', async ({ page }) => {
  const created = await page.request.post('/api/create-page', {
    data: { path: 'saved-text.md' },
  });
  expect(created.status(), await created.text()).toBe(200);

  const sentinel = `Saved text ${Date.now()}`;
  await openApp(page, '#/saved-text');
  await typeAtEnd(page, sentinel);

  await expect.poll(() => readOnDisk('saved-text.md'), { timeout: 30_000 }).toContain(sentinel);

  await page.reload();
  await expect(editor(page)).toContainText(sentinel);
});

test('two windows see each other edit live', async ({ browser }) => {
  const first = await (await browser.newContext()).newPage();
  const second = await (await browser.newContext()).newPage();
  await openApp(first, '#/welcome');
  await openApp(second, '#/welcome');
  await expect(editor(first)).toContainText('Welcome');
  await expect(editor(second)).toContainText('Welcome');

  const fromFirst = `From the first window ${Date.now()}`;
  await typeAtEnd(first, fromFirst);
  await expect(editor(second)).toContainText(fromFirst);

  const fromSecond = `From the second window ${Date.now()}`;
  await typeAtEnd(second, fromSecond);
  await expect(editor(first)).toContainText(fromSecond);
});
