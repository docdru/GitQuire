import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { __resetStartupMarksForTest, firstContent, pageListReady } from './startup-marks';

const globalRef = globalThis as unknown as { window?: { okDesktop?: unknown } };
const HAD_WINDOW = 'window' in globalRef;
const ORIGINAL_WINDOW = globalRef.window;

function win(): { okDesktop?: unknown } {
  globalRef.window ??= {};
  return globalRef.window;
}

function clearBridge(): void {
  delete win().okDesktop;
}

beforeEach(() => {
  __resetStartupMarksForTest();
});

afterEach(() => {
  __resetStartupMarksForTest();
  if (HAD_WINDOW) globalRef.window = ORIGINAL_WINDOW;
  else delete globalRef.window;
});

describe('startup-marks', () => {
  test('is a no-op (no throw) when the desktop bridge is absent', () => {
    clearBridge();
    expect(() => {
      pageListReady();
      firstContent();
    }).not.toThrow();
  });

  test('is a no-op when the bridge lacks the startup surface (older host)', () => {
    win().okDesktop = {};
    expect(() => {
      pageListReady();
      firstContent();
    }).not.toThrow();
  });
});
