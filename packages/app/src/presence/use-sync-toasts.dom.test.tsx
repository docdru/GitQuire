import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const warning = vi.fn();
const success = vi.fn();
const dismiss = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    warning: (...args: unknown[]) => warning(...args),
    success: (...args: unknown[]) => success(...args),
    dismiss: (...args: unknown[]) => dismiss(...args),
    error: () => {},
  },
}));

import { FORCE_SYNC_INTERVAL_MS } from '@/editor/provider-pool';
import { SYNC_CATCHUP_GRACE_MS, useSyncToasts } from './use-sync-toasts';

const messages = (spy: typeof warning): string[] => spy.mock.calls.map((c) => String(c[0]));

const lastWarning = () => warning.mock.calls.at(-1) as [string, { action?: unknown }] | undefined;

type Phase = 'connecting' | 'connected' | 'synced' | 'disconnected';

interface OutageToastOptions {
  action?: unknown;
  duration?: number;
  onDismiss?: () => void;
  onAutoClose?: () => void;
}

const lastOutageToast = () => warning.mock.calls.at(-1) as [string, OutageToastOptions] | undefined;

const renderToasts = (initial: Phase = 'synced') =>
  renderHook(({ s, doc }: { s: Phase; doc: string }) => useSyncToasts(s, doc), {
    initialProps: { s: initial, doc: 'a.md' },
  });

describe('useSyncToasts — disconnect grace downgrade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    warning.mockClear();
    success.mockClear();
    dismiss.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('downgrades to the honest "server stopped" copy after the grace with no reconnect', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      {
        initialProps: { s: 'synced' as const },
      },
    );

    act(() => rerender({ s: 'disconnected' }));
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(true);
    warning.mockClear();

    act(() => vi.advanceTimersByTime(10_000));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('a reconnect before the grace cancels the downgrade (no "server stopped")', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      {
        initialProps: { s: 'synced' as const },
      },
    );

    act(() => rerender({ s: 'disconnected' }));
    warning.mockClear();
    act(() => rerender({ s: 'synced' }));
    act(() => vi.advanceTimersByTime(10_000));

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    expect(success).toHaveBeenCalled();
  });

  test('disconnected → connected → synced shows Reconnected with no false "server stopped" and no premature dismiss', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connected' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(2_000));
    dismiss.mockClear();
    act(() => rerender({ s: 'connected' }));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => rerender({ s: 'synced' }));
    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
  });

  test('browser mode (no bridge): honest toast is message-only, no Restart control', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000));

    const last = lastWarning();
    expect(String(last?.[0])).toContain('server stopped');
    expect(String(last?.[0])).not.toMatch(/restart it/i);
    expect(last?.[1]?.action).toBeUndefined();
  });

  test('a bare `connected` socket before the grace cancels the downgrade (no "server stopped")', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connected' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    warning.mockClear();
    act(() => rerender({ s: 'connected' }));
    act(() => vi.advanceTimersByTime(10_000));

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
  });

  test('a `connected` AFTER the downgrade replaces the false "server stopped" claim (browser mode: message-only)', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connected' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'connected' }));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(8_000));
    const last = lastWarning();
    expect(String(last?.[0])).toMatch(/taking longer than usual/i);
    expect(String(last?.[0])).not.toMatch(/restart it/i);
    expect(last?.[1]?.action).toBeUndefined();
  });

  test('switching docs mid-outage carries the terminal claim over — no fresh "will sync" promise from a dead server', () => {
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'disconnected'; doc: string }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'disconnected', doc: 'b.md' }));
    expect(dismiss).not.toHaveBeenCalled();
    const last = lastWarning();
    expect(String(last?.[0])).toContain('server stopped');
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(false);
  });

  test('switching docs as the outage ends replaces the claim with "Reconnected" — no dismiss-then-recreate', () => {
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'disconnected'; doc: string }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    dismiss.mockClear();

    act(() => rerender({ s: 'synced', doc: 'b.md' }));
    expect(dismiss).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
  });

  test('a blip resolved by switching straight to an already-synced doc leaves no stale clock — a later outage gets a full fresh grace', () => {
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'disconnected'; doc: string }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(3_000));
    act(() => rerender({ s: 'synced', doc: 'b.md' }));
    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
    act(() => vi.advanceTimersByTime(30_000));
    warning.mockClear();

    act(() => rerender({ s: 'disconnected', doc: 'b.md' }));
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(true);
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    act(() => vi.advanceTimersByTime(9_999));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('focusing a non-document tab mid-grace keeps the toast and the clock — a doc reopen re-arms the REMAINDER', () => {
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'connecting' | 'disconnected'; doc: string | null }) =>
        useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(5_000));
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'disconnected', doc: null }));
    act(() => rerender({ s: 'connecting', doc: null }));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(3_000));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);

    act(() => rerender({ s: 'disconnected', doc: 'b.md' }));
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(true);
    act(() => vi.advanceTimersByTime(1_999));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('a grace that elapses entirely on a non-document tab does not fire — the reopen delivers the honest copy', () => {
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'connecting' | 'disconnected'; doc: string | null }) =>
        useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(5_000));
    act(() => rerender({ s: 'disconnected', doc: null }));
    act(() => rerender({ s: 'connecting', doc: null }));
    dismiss.mockClear();
    warning.mockClear();

    act(() => vi.advanceTimersByTime(6_000));
    expect(warning).not.toHaveBeenCalled();

    act(() => rerender({ s: 'disconnected', doc: 'b.md' }));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  test('focusing a non-document tab AFTER the downgrade keeps the terminal claim — a doc reopen re-asserts it, not the optimistic promise', () => {
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'connecting' | 'disconnected'; doc: string | null }) =>
        useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'disconnected', doc: null }));
    act(() => rerender({ s: 'connecting', doc: null }));
    expect(dismiss).not.toHaveBeenCalled();

    act(() => rerender({ s: 'disconnected', doc: 'b.md' }));
    const last = lastWarning();
    expect(String(last?.[0])).toContain('server stopped');
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(false);
  });

  test('a doc reopen at `synced` after a non-document hop resolves the carried claim with "Reconnected"', () => {
    const { rerender } = renderHook(
      ({
        s,
        doc,
      }: {
        s: 'synced' | 'connecting' | 'connected' | 'disconnected';
        doc: string | null;
      }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    act(() => rerender({ s: 'connecting', doc: null }));
    dismiss.mockClear();
    success.mockClear();

    act(() => rerender({ s: 'connecting', doc: 'b.md' }));
    act(() => rerender({ s: 'connected', doc: 'b.md' }));
    act(() => rerender({ s: 'synced', doc: 'b.md' }));

    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
    expect(dismiss).not.toHaveBeenCalled();
  });

  test('switching docs right after a healthy reconnect leaves the expiring "Reconnected" toast alone', () => {
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'disconnected'; doc: string }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => rerender({ s: 'synced', doc: 'a.md' }));
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'synced', doc: 'b.md' }));
    expect(dismiss).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledTimes(1);
  });

  test('a clean first connect is silent (no prior outage, no stalled toast)', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'connecting' | 'connected' | 'synced' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'connecting' as const } },
    );
    act(() => rerender({ s: 'connected' }));
    expect(warning).not.toHaveBeenCalled();
    act(() => rerender({ s: 'synced' }));
    expect(warning).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  test('the grace survives a disconnected→connecting churn cycle (timer is not per-branch)', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connecting' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(4_000));
    act(() => rerender({ s: 'connecting' }));
    act(() => vi.advanceTimersByTime(4_000));
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(2_000));

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('after the downgrade, a connecting→disconnected churn re-asserts the terminal copy, not the optimistic one', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connecting' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000));
    warning.mockClear();

    act(() => rerender({ s: 'connecting' }));
    act(() => rerender({ s: 'disconnected' }));

    const last = lastWarning();
    expect(String(last?.[0])).toContain('server stopped');
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(false);
  });

  test('the grace boundary is exact: no downgrade at 9,999ms, downgrade at 10,000ms', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(9_999));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('unmounting mid-grace cancels the pending downgrade (no toast from a dead hook)', () => {
    const { rerender, unmount } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(5_000));
    unmount();
    act(() => vi.advanceTimersByTime(10_000));

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
  });

  test('churn cannot orphan a second grace timer — cancel kills the ONLY pending downgrade', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connecting' | 'connected' | 'disconnected' }) =>
        useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(4_000));
    act(() => rerender({ s: 'connecting' }));
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(4_000));
    act(() => rerender({ s: 'connected' }));
    act(() => vi.advanceTimersByTime(30_000));

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
  });
});

describe('useSyncToasts — the transport-up, document-unsynced claim', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    warning.mockClear();
    success.mockClear();
    dismiss.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a healthy reconnect handshake raises no warning at all', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(2_000));
    warning.mockClear();

    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(warning).not.toHaveBeenCalled();

    act(() => rerender({ s: 'synced', doc: 'a.md' }));
    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
    expect(warning).not.toHaveBeenCalled();
  });

  test('the claim waits out a grace before it is asserted', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    warning.mockClear();

    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(7_999));
    expect(warning).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test('a socket that re-syncs inside the grace never asserts the claim', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    warning.mockClear();

    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(7_000));
    act(() => rerender({ s: 'synced', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(30_000));

    expect(warning).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
  });

  test('the claim stands for as long as the stall does — it never goes silent on a true condition', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    warning.mockClear();
    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(8_000));
    expect(warning).toHaveBeenCalledTimes(1);
    expect(lastOutageToast()?.[1]?.duration).toBe(Number.POSITIVE_INFINITY);

    act(() => vi.advanceTimersByTime(600_000));
    expect(dismiss).not.toHaveBeenCalled();
    expect(String(lastOutageToast()?.[0])).toMatch(/taking longer than usual/i);
  });

  test('the claim is retired by the reconnect edge, not by a clock', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(8_000));
    expect(String(lastOutageToast()?.[0])).toMatch(/taking longer than usual/i);
    success.mockClear();

    act(() => rerender({ s: 'synced', doc: 'a.md' }));
    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
  });

  test('a doc switch while the claim stands does not re-arm a second grace', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(8_000));
    warning.mockClear();

    act(() => rerender({ s: 'connected', doc: 'b.md' }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(warning).not.toHaveBeenCalled();
  });

  test('the copy neither claims lost edits nor prescribes a restart', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    warning.mockClear();
    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(8_000));

    const message = String(lastOutageToast()?.[0]);
    expect(message).not.toMatch(/aren't reaching the server/i);
    expect(message).not.toMatch(/restart it/i);
    expect(message).toMatch(/taking longer than usual/i);
  });

  test('dismissing the claim retires it for good — it does not re-raise itself', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(8_000));

    const onDismiss = lastOutageToast()?.[1]?.onDismiss;
    expect(typeof onDismiss).toBe('function');
    act(() => onDismiss?.());
    warning.mockClear();

    act(() => rerender({ s: 'connected', doc: 'b.md' }));
    act(() => vi.advanceTimersByTime(30_000));
    expect(warning).not.toHaveBeenCalled();
  });

  test('a dismissal is scoped to the episode — a later outage can raise the claim again', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(8_000));
    act(() => lastOutageToast()?.[1]?.onDismiss?.());

    act(() => rerender({ s: 'synced', doc: 'a.md' }));
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    warning.mockClear();
    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(8_000));

    expect(String(lastOutageToast()?.[0])).toMatch(/taking longer than usual/i);
  });

  test('the genuine outage notices carry no dismiss handler — only the claim is opt-out-able', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    expect(lastOutageToast()?.[1]?.onDismiss).toBeUndefined();
    expect(lastOutageToast()?.[1]?.onAutoClose).toBeUndefined();

    act(() => vi.advanceTimersByTime(10_000));
    expect(String(lastOutageToast()?.[0])).toContain('server stopped');
    expect(lastOutageToast()?.[1]?.onDismiss).toBeUndefined();
  });

  test('dismissing "Connection lost" still lets the worse "server stopped" news through', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    warning.mockClear();

    act(() => vi.advanceTimersByTime(10_000));
    expect(String(lastOutageToast()?.[0])).toContain('server stopped');
  });

  test('unmounting mid-grace cancels the pending claim (no toast from a dead hook)', () => {
    const { rerender, unmount } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(4_000));
    warning.mockClear();

    unmount();
    act(() => vi.advanceTimersByTime(30_000));
    expect(warning).not.toHaveBeenCalled();
  });

  test('leaving the document mid-grace discards the clock — a reopen gets a full fresh grace', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(7_000));
    warning.mockClear();

    act(() => rerender({ s: 'connected', doc: null as unknown as string }));
    act(() => vi.advanceTimersByTime(30_000));
    expect(warning).not.toHaveBeenCalled();

    act(() => rerender({ s: 'connected', doc: 'b.md' }));
    act(() => vi.advanceTimersByTime(7_999));
    expect(warning).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(String(lastOutageToast()?.[0])).toMatch(/taking longer than usual/i);
  });

  test('the grace is derived from the pool resync interval, not a bare literal', () => {
    expect(SYNC_CATCHUP_GRACE_MS).toBeGreaterThan(FORCE_SYNC_INTERVAL_MS);
  });

  test('the genuine outage notices stay unbounded, and so does the claim', () => {
    const { rerender } = renderToasts();
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    expect(String(lastOutageToast()?.[0])).toContain('keep this tab open');
    expect(lastOutageToast()?.[1]?.duration).toBe(Number.POSITIVE_INFINITY);

    act(() => vi.advanceTimersByTime(10_000));
    expect(String(lastOutageToast()?.[0])).toContain('server stopped');
    expect(lastOutageToast()?.[1]?.duration).toBe(Number.POSITIVE_INFINITY);

    act(() => rerender({ s: 'connected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(8_000));
    expect(String(lastOutageToast()?.[0])).toMatch(/taking longer than usual/i);
    expect(lastOutageToast()?.[1]?.duration).toBe(Number.POSITIVE_INFINITY);
  });
});
