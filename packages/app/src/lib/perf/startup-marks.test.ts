import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetStartupMarksForTest,
  firstContent,
  onFirstContent,
  pageListReady,
} from './startup-marks';

beforeEach(() => {
  __resetStartupMarksForTest();
});

afterEach(() => {
  __resetStartupMarksForTest();
});

describe('startup-marks', () => {
  test('reports first content once, after both the page list and the active document are ready', () => {
    const listener = vi.fn();
    onFirstContent(listener);

    pageListReady();
    expect(listener).not.toHaveBeenCalled();
    firstContent();
    firstContent();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(typeof listener.mock.calls[0]?.[0]).toBe('number');
  });

  test('a listener added after the report is called with the recorded time', () => {
    pageListReady();
    firstContent();

    const listener = vi.fn();
    onFirstContent(listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
