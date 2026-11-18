import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const CSS = readFileSync(join(__dirname, 'globals.css'), 'utf8');

function themedDeskSelectors(css: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => {
    const selector = (match[1] ?? '').replace(/:not\(\s*\[data-color-theme\]\s*\)/g, '');
    const body = match[2] ?? '';
    return /\[data-color-theme\b/.test(selector) && /--desk\s*:/.test(body)
      ? [selector.trim()]
      : [];
  });
}

describe('globals.css — the desk token follows the active colour theme', () => {
  test('--desk stays relative to the sidebar in light and named dark themes, with a fixed default dark frame', () => {
    const root = CSS.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(root).toMatch(/--desk:\s*oklch\(from var\(--sidebar\)\s+calc\(l - 0\.015\)\s+c\s+h\)/);
    const dark = CSS.match(/\n\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(dark).not.toMatch(/--desk\s*:/);
    expect(CSS).toMatch(
      /html\.dark:not\(\[data-color-theme\]\)\s*\{[^}]*--desk:\s*oklch\(0\.15 0 0\)/,
    );
    expect(themedDeskSelectors(CSS)).toEqual([]);
    expect(themedDeskSelectors('html.dark[data-color-theme="dracula"] { --desk: red; }')).toEqual([
      'html.dark[data-color-theme="dracula"]',
    ]);
  });
});
