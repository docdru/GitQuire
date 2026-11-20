import { afterEach, describe, expect, test } from 'vitest';
import { ASK_COMPOSER_CLEARANCE_VAR, publishAskComposerHeight } from './ask-composer-inset';

function publishedCss(): string {
  return Array.from(document.head.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n');
}

afterEach(() => {
  publishAskComposerHeight(null);
});

describe('publishAskComposerHeight', () => {
  test('publishes the clearance on the root so overlays outside the scroller can read it', () => {
    publishAskComposerHeight(140, 92);
    expect(publishedCss()).toContain(`:root { ${ASK_COMPOSER_CLEARANCE_VAR}: 92px; }`);
  });

  test('falls back to the reserved height when no clearance is given', () => {
    publishAskComposerHeight(140);
    expect(publishedCss()).toContain(`:root { ${ASK_COMPOSER_CLEARANCE_VAR}: 140px; }`);
  });

  test('republishes when only the clearance changes', () => {
    publishAskComposerHeight(140, 92);
    publishAskComposerHeight(140, 100);
    expect(publishedCss()).toContain(`${ASK_COMPOSER_CLEARANCE_VAR}: 100px`);
  });

  test('removes the clearance when the composer goes away', () => {
    publishAskComposerHeight(140, 92);
    publishAskComposerHeight(null);
    expect(publishedCss()).not.toContain(ASK_COMPOSER_CLEARANCE_VAR);
  });
});
