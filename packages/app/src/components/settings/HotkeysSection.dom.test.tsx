import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts';
import { HotkeysSection } from './HotkeysSection';

function renderedShortcutIds(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="settings-hotkey-"]')).map((row) =>
    (row.getAttribute('data-testid') ?? '').replace('settings-hotkey-', ''),
  );
}

function renderedCategoryLabels(): string[] {
  return Array.from(document.querySelectorAll('h4[id^="settings-hotkeys-"]')).map(
    (heading) => heading.textContent ?? '',
  );
}

function renderSection(): void {
  render(<HotkeysSection />);
}

afterEach(() => {
  cleanup();
});

describe('HotkeysSection rows', () => {
  test('lists every shortcut in the catalogue', () => {
    renderSection();

    expect(renderedShortcutIds().sort()).toEqual(
      KEYBOARD_SHORTCUTS.map((shortcut) => shortcut.id).sort(),
    );
    expect(renderedCategoryLabels().length).toBeGreaterThan(0);
  });
});
