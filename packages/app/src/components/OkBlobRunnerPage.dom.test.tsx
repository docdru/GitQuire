import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@/components/OkBlobRunner', () => ({
  GqBlobRunner: ({ autoStart }: { autoStart?: boolean }) => (
    <div data-testid="runner-probe" data-autostart={String(autoStart ?? false)} />
  ),
}));

describe('GqBlobRunnerPage', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('takes focus on mount', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const { GqBlobRunnerPage } = await import('./OkBlobRunnerPage');
    render(<GqBlobRunnerPage />);
    expect(focus).toHaveBeenCalled();
  });

  test('does not auto-start by default, and does when asked', async () => {
    const { GqBlobRunnerPage } = await import('./OkBlobRunnerPage');
    const { getByTestId, unmount } = render(<GqBlobRunnerPage />);
    expect(getByTestId('runner-probe').dataset.autostart).toBe('false');
    unmount();

    const revealed = render(<GqBlobRunnerPage autoStart />);
    expect(revealed.getByTestId('runner-probe').dataset.autostart).toBe('true');
  });
});
