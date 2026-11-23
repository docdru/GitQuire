import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CurrentDraft, DraftSummary } from './drafts-api';

const toasts = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
  loading: vi.fn(),
}));

const api = vi.hoisted(() => ({
  publishDraft: vi.fn(),
  discardDraft: vi.fn(),
  updateDraft: vi.fn(),
  openView: vi.fn(),
  fetchCurrentDraft: vi.fn(),
}));

const store = vi.hoisted(() => ({
  viewing: null as { slug: string } | null,
  reloadIntoView: vi.fn(),
  refreshDrafts: vi.fn(async () => undefined),
}));

vi.mock('sonner', () => ({ toast: toasts }));

vi.mock('./drafts-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./drafts-api')>()),
  ...api,
}));

vi.mock('./drafts-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./drafts-store')>()),
  draftSnapshot: () => ({
    loaded: true,
    list: null,
    current: { viewing: store.viewing, drift: null, closed: null },
  }),
  reloadIntoView: store.reloadIntoView,
  refreshDrafts: store.refreshDrafts,
}));

const DRAFT: DraftSummary = {
  slug: 'plan',
  branch: 'draft/plan',
  title: 'Plan',
  status: 'review',
  author: { id: 1, login: 'alice', name: 'Alice' },
  createdAt: '2026-11-18T10:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z',
  base: 'main',
  pullUrl: null,
  reviews: [],
  requests: [],
  pages: [{ path: 'notes.md', change: 'modified' }],
  agent: false,
  closedAt: null,
  closedBy: null,
};

const PUBLISHED_BY_BOB: CurrentDraft = {
  viewing: null,
  drift: null,
  closing: false,
  closed: {
    slug: 'plan',
    title: 'Plan',
    status: 'published',
    closedBy: { id: 2, login: 'bob', name: 'Bob' },
  },
};

type Phase = 'connecting' | 'connected' | 'synced' | 'disconnected';

async function load() {
  const toastsModule = await import('@/presence/use-sync-toasts');
  const actions = await import('@/components/gitquire-drafts/draft-actions');
  const handover = await import('./draft-handover');
  const render = (first: Phase = 'synced') =>
    renderHook(({ s }: { s: Phase }) => toastsModule.useSyncToasts(s, 'notes.md'), {
      initialProps: { s: first },
    });
  return { actions, handover, render };
}

const lostConnectionToasts = () =>
  toasts.warning.mock.calls
    .map((call) => String(call[0]))
    .filter((text) => text.includes('Connection lost') || text.includes('server stopped'));

const storedNotice = () => window.sessionStorage.getItem('gitquire:draft-notice');

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  for (const spy of Object.values(toasts)) spy.mockReset();
  for (const spy of Object.values(api)) spy.mockReset();
  store.reloadIntoView.mockReset();
  store.refreshDrafts.mockClear();
  store.viewing = { slug: 'plan' };
  api.openView.mockResolvedValue(undefined);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('leaving a draft that closes', () => {
  test('publishing the open draft shows no lost connection and goes live as soon as the answer arrives', async () => {
    const { actions, render } = await load();
    const answer = Promise.withResolvers<DraftSummary>();
    api.publishDraft.mockReturnValue(answer.promise);
    const hook = render();

    const publishing = actions.publishAndLeave(DRAFT);
    act(() => hook.rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(15_000));
    expect(lostConnectionToasts()).toEqual([]);
    expect(store.reloadIntoView).not.toHaveBeenCalled();

    await act(async () => {
      answer.resolve({ ...DRAFT, status: 'published' });
      await publishing;
    });
    expect(store.reloadIntoView).toHaveBeenCalledTimes(1);
    expect(lostConnectionToasts()).toEqual([]);
    expect(storedNotice()).toBe('"Plan" is live. You are now on the live wiki.');
  });

  test('discarding the open draft shows no lost connection and goes live as soon as the answer arrives', async () => {
    const { actions, render } = await load();
    const answer = Promise.withResolvers<DraftSummary>();
    api.discardDraft.mockReturnValue(answer.promise);
    const hook = render();

    const discarding = actions.discardAndLeave(DRAFT);
    act(() => hook.rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(15_000));
    expect(lostConnectionToasts()).toEqual([]);

    await act(async () => {
      answer.resolve({ ...DRAFT, status: 'discarded' });
      await discarding;
    });
    expect(store.reloadIntoView).toHaveBeenCalledTimes(1);
    expect(lostConnectionToasts()).toEqual([]);
    expect(storedNotice()).toBe('"Plan" was discarded. You are now on the live wiki.');
  });

  test('someone else publishing the draft gives one plain notice and an immediate switch to the live wiki', async () => {
    const { render } = await load();
    api.fetchCurrentDraft.mockResolvedValue(PUBLISHED_BY_BOB);
    const hook = render();

    act(() => hook.rerender({ s: 'disconnected' }));
    await flush();

    expect(lostConnectionToasts()).toEqual([]);
    expect(api.openView).toHaveBeenCalledWith(null);
    expect(store.reloadIntoView).toHaveBeenCalledTimes(1);
    expect(storedNotice()).toBe('Bob published "Plan". You are now on the live wiki.');

    act(() => vi.advanceTimersByTime(15_000));
    expect(lostConnectionToasts()).toEqual([]);
  });

  test('a draft someone else is still publishing stays quiet until it is closed', async () => {
    const { render } = await load();
    api.fetchCurrentDraft
      .mockResolvedValueOnce({ viewing: DRAFT, drift: null, closing: true, closed: null })
      .mockResolvedValue(PUBLISHED_BY_BOB);
    const hook = render();

    act(() => hook.rerender({ s: 'disconnected' }));
    await flush();
    expect(store.reloadIntoView).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(lostConnectionToasts()).toEqual([]);
    expect(store.reloadIntoView).toHaveBeenCalledTimes(1);
    expect(storedNotice()).toBe('Bob published "Plan". You are now on the live wiki.');
  });

  test('the notice is shown once after the page is back on the live wiki', async () => {
    const { handover } = await load();
    handover.leaveDraft('"Plan" is live. You are now on the live wiki.');
    expect(handover.takeLeaveNotice()).toBe('"Plan" is live. You are now on the live wiki.');
    expect(handover.takeLeaveNotice()).toBeNull();
  });
});

describe('a real connection loss', () => {
  test('still warns while a draft is open and nobody closed it', async () => {
    const { render } = await load();
    api.fetchCurrentDraft.mockResolvedValue({
      viewing: DRAFT,
      drift: null,
      closing: false,
      closed: null,
    });
    const hook = render();

    act(() => hook.rerender({ s: 'disconnected' }));
    await flush();

    expect(lostConnectionToasts()[0]).toContain('Connection lost');
    expect(store.reloadIntoView).not.toHaveBeenCalled();
  });

  test('still warns when the server cannot be asked', async () => {
    const { render } = await load();
    api.fetchCurrentDraft.mockRejectedValue(new TypeError('Failed to fetch'));
    const hook = render();

    act(() => hook.rerender({ s: 'disconnected' }));
    await flush();

    expect(lostConnectionToasts()[0]).toContain('Connection lost');
  });

  test('warns at once on the live wiki', async () => {
    store.viewing = null;
    const { render } = await load();
    const hook = render();

    act(() => hook.rerender({ s: 'disconnected' }));

    expect(lostConnectionToasts()[0]).toContain('Connection lost');
    expect(api.fetchCurrentDraft).not.toHaveBeenCalled();
  });

  test('warns again when a publish fails and the connection stays down', async () => {
    const { actions, render } = await load();
    api.publishDraft.mockRejectedValue(new TypeError('Failed to fetch'));
    api.fetchCurrentDraft.mockResolvedValue({
      viewing: DRAFT,
      drift: null,
      closing: false,
      closed: null,
    });
    const hook = render();

    const publishing = actions.publishAndLeave(DRAFT);
    act(() => hook.rerender({ s: 'disconnected' }));
    await act(async () => {
      expect((await publishing).kind).toBe('failed');
    });
    await flush();

    expect(store.reloadIntoView).not.toHaveBeenCalled();
    expect(lostConnectionToasts()[0]).toContain('Connection lost');
  });
});

describe('arriving in a draft after the reload', () => {
  test('switching into a draft marks the arrival before the page reloads', async () => {
    store.viewing = null;
    const { actions, handover } = await load();
    await act(async () => {
      await actions.switchView('plan');
    });
    expect(store.reloadIntoView).toHaveBeenCalledTimes(1);
    expect(handover.arrivingView()).toBeNull();
    expect(window.sessionStorage.getItem('gitquire:arriving-view')).toMatch(/^draft:\d+$/);
  });

  test('the reloaded page shows a loading notice and no lost connection until it is synced', async () => {
    window.sessionStorage.setItem('gitquire:arriving-view', `draft:${Date.now()}`);
    const { handover, render } = await load();
    expect(handover.arrivingView()).toBe('draft');
    expect(window.sessionStorage.getItem('gitquire:arriving-view')).toBeNull();

    const hook = render('connecting');
    expect(String(toasts.loading.mock.calls[0]?.[0])).toContain('Opening the draft');
    act(() => hook.rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(15_000));
    expect(lostConnectionToasts()).toEqual([]);

    act(() => hook.rerender({ s: 'synced' }));
    expect(handover.arrivingView()).toBeNull();
    expect(toasts.dismiss).toHaveBeenCalledWith('arriving-view');
  });

  test('a stale arrival marker is ignored', async () => {
    window.sessionStorage.setItem('gitquire:arriving-view', `draft:${Date.now() - 120_000}`);
    const { handover } = await load();
    expect(handover.arrivingView()).toBeNull();
  });

  test('the loading notice gives way after the arrival wait if the page never syncs', async () => {
    window.sessionStorage.setItem('gitquire:arriving-view', `live:${Date.now()}`);
    store.viewing = null;
    const { handover, render } = await load();
    const hook = render('connecting');
    expect(String(toasts.loading.mock.calls[0]?.[0])).toContain('Opening the live wiki');
    act(() => hook.rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(61_000));
    expect(handover.arrivingView()).toBeNull();
    expect(handover.handoverState()).toBe('none');
    expect(toasts.dismiss).toHaveBeenCalledWith('arriving-view');
  });
});
