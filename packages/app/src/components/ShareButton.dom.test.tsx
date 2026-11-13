import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { formatShortcutBinding, formatShortcutBindingLabel } from '@/lib/keyboard-shortcuts';
import type { ShareTargetInput } from '@/lib/share/run-share-action';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ projectLocalBinding: { patch: () => ({ ok: true }) } }),
}));

const { ShareButton } = await import('./ShareButton');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function renderShareButton(input: ShareTargetInput | null) {
  return render(
    <TooltipProvider>
      <ShareButton input={input} onClickWhenNoRemote={() => {}} />
    </TooltipProvider>,
  );
}

describe('ShareButton', () => {
  const pageLink = (route: string) => `${window.location.origin}${window.location.pathname}${route}`;

  beforeEach(() => {
    if (typeof window !== 'undefined') window.location.hash = '';
    Reflect.deleteProperty(globalThis, 'okDesktop');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  });
  afterEach(() => {
    cleanup();
  });

  test('renders an enabled button for a folder target', () => {
    renderShareButton({ kind: 'folder', folderRelativePath: 'guides' });

    const button = screen.getByRole('button', { name: 'Share folder' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  test('renders an enabled button for a doc target', () => {
    renderShareButton({ kind: 'doc', docName: 'notes' });

    const button = screen.getByRole('button', { name: 'Share doc' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  test('renders a DISABLED button (not absent) when input is null', () => {
    renderShareButton(null);

    const button = screen.queryByTestId('share-button');
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test('copies the page link on this server and shows it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderShareButton({ kind: 'doc', docName: 'docs/readme' });

    fireEvent.click(screen.getByRole('button', { name: 'Share doc' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-button-popover')).not.toBeNull();
    });
    const input = screen.getByLabelText('Share URL') as HTMLInputElement;
    expect(input.value).toBe(pageLink('#/docs/readme'));
    expect(writeText).toHaveBeenCalledWith(pageLink('#/docs/readme'));
    expect(screen.getByRole('button', { name: 'Copied!' })).not.toBeNull();
  });

  test('shows a folder link to copy by hand when the clipboard is unavailable', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    renderShareButton({ kind: 'folder', folderRelativePath: 'guides' });

    fireEvent.click(screen.getByRole('button', { name: 'Share folder' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-button-popover')).not.toBeNull();
    });
    const input = screen.getByLabelText('Share URL') as HTMLInputElement;
    expect(input.value).toBe(pageLink('#/guides/'));
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
    const copyBinding = { mac: '⌘ C', windowsLinux: 'Ctrl C' };
    const copyKeycap = screen
      .getByTestId('share-button-popover')
      .querySelector('[data-slot="kbd"]');
    expect(copyKeycap?.textContent).toBe(formatShortcutBinding(copyBinding));
    expect(copyKeycap?.getAttribute('aria-label')).toBe(formatShortcutBindingLabel(copyBinding));
  });
});
