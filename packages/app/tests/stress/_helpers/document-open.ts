import { expect, type Page } from '@playwright/test';

const DOCUMENT_OPEN_TIMEOUT_MS = 30_000;

export async function expectDocumentOpen(page: Page, docName: string): Promise<void> {
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText(docName, {
    timeout: DOCUMENT_OPEN_TIMEOUT_MS,
  });
}
