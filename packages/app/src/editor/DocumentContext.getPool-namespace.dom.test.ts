import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const WS_URL = 'ws://localhost:1/collab';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete window.okDesktop;
  window.localStorage.clear();
});

describe('getPool storage-namespace wiring', () => {
  test('web host with no bridge keeps the bare key — the per-port origin isolates it', async () => {
    const { getPool } = await import('./DocumentContext');
    const pool = getPool(WS_URL);
    try {
      pool.setObservedBranch('main');
      expect(window.localStorage.getItem('ok-last-observed-branch')).toBe('main');
    } finally {
      pool.dispose();
    }
  });
});
