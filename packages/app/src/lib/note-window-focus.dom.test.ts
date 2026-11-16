import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  __resetNoteWindowFocusClaimForTests,
  claimNoteWindowInitialFocus,
} from './note-window-focus.ts';

type GqDesktopStub = { config: { mode: string } };

function stubMode(mode: string | null): void {
  if (mode === null) {
    (window as unknown as { okDesktop?: GqDesktopStub }).okDesktop = undefined;
    return;
  }
  (window as unknown as { okDesktop?: GqDesktopStub }).okDesktop = { config: { mode } };
}

beforeEach(() => {
  __resetNoteWindowFocusClaimForTests();
});

afterEach(() => {
  stubMode(null);
  __resetNoteWindowFocusClaimForTests();
});

describe('claimNoteWindowInitialFocus', () => {
  test('a later mount finds the claim spent, so focus is never yanked back', () => {
    stubMode('note');
    claimNoteWindowInitialFocus();

    expect(claimNoteWindowInitialFocus()).toBe(false);
    expect(claimNoteWindowInitialFocus()).toBe(false);
  });

  test.each(['editor', 'navigator', 'terminal'])('the %s window mode never autofocuses', (mode) => {
    stubMode(mode);
    expect(claimNoteWindowInitialFocus()).toBe(false);
  });

  test('the web host never autofocuses', () => {
    stubMode(null);
    expect(claimNoteWindowInitialFocus()).toBe(false);
  });
});
