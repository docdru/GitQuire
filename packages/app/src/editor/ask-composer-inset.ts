import {
  CONFLICT_SCROLLPORT_SELECTOR,
  DOCUMENT_SCROLL_HOST_SELECTOR,
  FULL_PAGE_CM_HOST_SELECTORS,
} from './document-scrollports';

export const ASK_COMPOSER_HEIGHT_VAR = '--ask-composer-height';
export const ASK_COMPOSER_CLEARANCE_VAR = '--ask-composer-clearance';

export const ASK_COMPOSER_INSET_SELECTORS = [
  DOCUMENT_SCROLL_HOST_SELECTOR,
  `${DOCUMENT_SCROLL_HOST_SELECTOR} :is(.ProseMirror, .cm-content)`,
  FULL_PAGE_CM_HOST_SELECTORS.mermaidDocEditor,
  `${FULL_PAGE_CM_HOST_SELECTORS.sourceEditor} .cm-content`,
  `${FULL_PAGE_CM_HOST_SELECTORS.textDocEditor} .cm-content`,
  CONFLICT_SCROLLPORT_SELECTOR,
  `${CONFLICT_SCROLLPORT_SELECTOR} diffs-container`,
] as const;

let publishedPx: number | null = null;
let insetStyle: HTMLStyleElement | null = null;

let publishedClearancePx: number | null = null;

export function publishAskComposerHeight(px: number | null, clearancePx: number | null = px): void {
  if (px === publishedPx && clearancePx === publishedClearancePx) return;
  publishedPx = px;
  publishedClearancePx = clearancePx;
  if (px === null) {
    insetStyle?.remove();
    insetStyle = null;
    return;
  }
  insetStyle ??= document.head.appendChild(document.createElement('style'));
  insetStyle.textContent = `${ASK_COMPOSER_INSET_SELECTORS.join(', ')} { ${ASK_COMPOSER_HEIGHT_VAR}: ${px}px; } :root { ${ASK_COMPOSER_CLEARANCE_VAR}: ${clearancePx ?? px}px; }`;
}

export function publishedAskComposerHeightPx(): number {
  return publishedPx ?? 0;
}
