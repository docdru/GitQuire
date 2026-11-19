import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SIDEBAR_PINS_KEY } from '@/lib/sidebar-pin-store';
import { SidebarProvider, useSidebar } from './sidebar';

function StateProbe() {
  const { state } = useSidebar();
  return <span data-testid="sidebar-state">{state}</span>;
}

function pressSidebarShortcut() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { altKey: true, metaKey: true, code: 'KeyS' }),
    );
  });
}

describe('SidebarProvider ⌥⌘S shortcut', () => {
  beforeEach(() => {
    window.innerWidth = 1400;
    window.localStorage.removeItem(SIDEBAR_PINS_KEY);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(SIDEBAR_PINS_KEY);
  });

  test('⌥⌘S toggles the sidebar', () => {
    render(
      <SidebarProvider>
        <StateProbe />
      </SidebarProvider>,
    );
    expect(screen.getByTestId('sidebar-state').textContent).toBe('expanded');

    pressSidebarShortcut();

    expect(screen.getByTestId('sidebar-state').textContent).toBe('collapsed');
  });

  test('⌥⌘S does NOT toggle while an overlay owns the keyboard', async () => {
    const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
      '@/components/ui/dialog'
    );
    render(
      <SidebarProvider>
        <StateProbe />
        <Dialog open>
          <DialogContent>
            <DialogTitle>Command palette</DialogTitle>
            <DialogDescription>Search files and commands</DialogDescription>
          </DialogContent>
        </Dialog>
      </SidebarProvider>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());
    expect(screen.getByTestId('sidebar-state').textContent).toBe('expanded');

    pressSidebarShortcut();

    expect(screen.getByTestId('sidebar-state').textContent).toBe('expanded');
  });

  test('Ctrl+Alt+S also toggles the sidebar', () => {
    render(
      <SidebarProvider>
        <StateProbe />
      </SidebarProvider>,
    );
    expect(screen.getByTestId('sidebar-state').textContent).toBe('expanded');

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { altKey: true, ctrlKey: true, code: 'KeyS' }),
      );
    });

    expect(screen.getByTestId('sidebar-state').textContent).toBe('collapsed');
  });
});
