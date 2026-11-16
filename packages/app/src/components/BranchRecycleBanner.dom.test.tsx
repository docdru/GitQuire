import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { BRANCH_SWITCH_NOTICE_MS, type ContentRecycleNotice } from '@/lib/branch-recycle-notice';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';

let notice: ContentRecycleNotice | null = null;
const dismiss = vi.fn();
const restartMock = vi.fn();

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    contentRecycleNotice: notice,
    dismissContentRecycleNotice: dismiss,
  }),
}));

async function renderBanner() {
  const { BranchRecycleBanner } = await import('./BranchRecycleBanner');
  return render(<BranchRecycleBanner />);
}

afterEach(() => {
  cleanup();
  notice = null;
  dismiss.mockReset();
  restartMock.mockReset();
});

test('renders nothing without a notice', async () => {
  await renderBanner();
  expect(screen.queryByTestId('branch-recycle-banner-switch')).toBeNull();
  expect(screen.queryByTestId('branch-recycle-banner-refused')).toBeNull();
});

test('a fresh branch switch shows the transient status naming the branch', async () => {
  notice = { kind: 'branch-switch', branch: 'feat/x', at: Date.now() };
  await renderBanner();
  const banner = screen.getByTestId('branch-recycle-banner-switch');
  expect(banner.textContent).toContain('feat/x');
  expect(banner.getAttribute('role')).toBe('status');
});

test('a refused notice is an alert with a Reload action and a working Dismiss', async () => {
  notice = { kind: 'refused', at: Date.now() };
  await renderBanner();
  const banner = screen.getByTestId('branch-recycle-banner-refused');
  expect(banner.getAttribute('role')).toBe('alert');
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(dismiss).toHaveBeenCalledTimes(1);
});

test('the transient switch banner dismisses itself after its deadline', async () => {
  vi.useFakeTimers();
  try {
    notice = { kind: 'branch-switch', branch: 'feat/x', at: Date.now() };
    await renderBanner();
    expect(screen.getByTestId('branch-recycle-banner-switch')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(BRANCH_SWITCH_NOTICE_MS + 50);
    });

    expect(screen.queryByTestId('branch-recycle-banner-switch')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('both variants start below the application header rather than over it', async () => {
  notice = { kind: 'branch-switch', branch: 'feat/x', at: Date.now() };
  await renderBanner();
  expectVisualClassTokens(screen.getByTestId('branch-recycle-banner-switch').className, [
    'fixed',
    'top-[var(--gq-app-header-height,0px)]',
    'inset-x-0',
  ]);

  cleanup();
  notice = { kind: 'refused', at: Date.now() };
  await renderBanner();
  expectVisualClassTokens(screen.getByTestId('branch-recycle-banner-refused').className, [
    'fixed',
    'top-[var(--gq-app-header-height,0px)]',
    'inset-x-0',
  ]);
});
