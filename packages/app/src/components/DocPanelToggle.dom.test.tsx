import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';

const { DocPanelToggle } = await import('./DocPanelToggle');

function renderToggle(isPanelCollapsed = false) {
  const onTogglePanel = () => {};
  render(
    <TooltipProvider>
      <DocPanelToggle isPanelCollapsed={isPanelCollapsed} onTogglePanel={onTogglePanel} />
    </TooltipProvider>,
  );
}

describe('DocPanelToggle', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders the document-panel shortcut as a Kbd keycap', async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.hover(
      screen.getByRole('button', {
        name: `Hide panel (${formatShortcutLabel('toggle-document-panel')})`,
      }),
    );
    const tooltip = await screen.findByRole('tooltip', {
      name: `Hide panel ${formatShortcutLabel('toggle-document-panel')}`,
    });
    expect(tooltip.querySelector('[data-slot="kbd"]')?.textContent).toBe(
      formatShortcut('toggle-document-panel'),
    );
  });

  test('exposes the panel state and target for assistive tech and the focus rescue', () => {
    renderToggle(true);
    const toggle = screen.getByRole('button', {
      name: `Show panel (${formatShortcutLabel('toggle-document-panel')})`,
    });

    expect(toggle.hasAttribute('data-doc-panel-toggle')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('doc-panel');
  });
});
