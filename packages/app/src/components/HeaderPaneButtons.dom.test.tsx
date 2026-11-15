import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { HeaderPaneButtons, useHeaderPaneButtonSet } from '@/components/HeaderPaneButtons';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfigContext } from '@/lib/config-context';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneVisibility,
  type PaneVisibilityRequest,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import {
  configContextWithTerminal,
  type ProjectTerminalSetting,
  TERMINAL_SETTING_UNSET,
} from '@/test-utils/config-context';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

const HIDDEN: PaneVisibility = { open: false, onScreen: false };
const SHOWN: PaneVisibility = { open: true, onScreen: true };
const OPEN_OFF_SCREEN: PaneVisibility = { open: true, onScreen: false };

const PRESSED_LOOK = ['bg-primary/10', 'text-primary'];
const PRESSED_HOVER_LOOK = ['hover:bg-primary/15'];
const HIGH_CONTRAST_OUTLINE = [
  'forced-colors:outline-solid',
  'forced-colors:outline-2',
  'contrast-more:outline-solid',
  'contrast-more:outline-2',
];
const SWITCHER_TRACK = ['bg-foreground/5', 'p-0.5', 'rounded-[10px]'];
const RAISED_SEGMENT = ['bg-background', 'shadow-sm'];

const ORIGINAL_PLATFORM = globalThis.navigator.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(globalThis.navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

function Providers({
  setting,
  children,
}: {
  setting: ProjectTerminalSetting;
  children: ReactNode;
}) {
  return (
    <ConfigContext value={configContextWithTerminal(setting)}>
      <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
    </ConfigContext>
  );
}

function renderButtons(setting: ProjectTerminalSetting = TERMINAL_SETTING_UNSET) {
  return render(
    <Providers setting={setting}>
      <HeaderPaneButtons />
    </Providers>,
  );
}

function paneButtonNames(): (string | null)[] {
  return within(screen.getByRole('group', { name: 'Panels' }))
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label'));
}

function recordRequests(): PaneVisibilityRequest[] {
  const requests: PaneVisibilityRequest[] = [];
  paneVisibilityStore.subscribeRequests((request) => requests.push(request));
  return requests;
}

function PaneSetProbe() {
  return <output data-testid="pane-set">{useHeaderPaneButtonSet().join(',')}</output>;
}

describe('HeaderPaneButtons', () => {
  afterEach(() => {
    __resetPaneVisibilityStoreForTests();
    setPlatform(ORIGINAL_PLATFORM);
  });

  test('renders Agents inside a group named Panels, after a divider', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    renderButtons();

    const group = screen.getByRole('group', { name: 'Panels' });
    expect(paneButtonNames()).toEqual(['Agents']);
    const divider = screen.getByTestId('header-pane-divider');
    expect(divider.getAttribute('data-orientation')).toBe('vertical');
    expect(divider.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.contains(group)).toBe(false);
  });

  test('never renders a Terminal button, even when the snapshot carries a terminal pane', () => {
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: SHOWN });
    renderButtons();

    expect(paneButtonNames()).toEqual(['Editor', 'Agents']);
    expect(screen.queryByTestId('header-pane-button-terminal')).toBeNull();
  });

  test('the Agents button is a 28px ghost icon button with a hidden glyph and a stable test id', () => {
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: null });
    renderButtons();

    const agents = screen.getByTestId('header-pane-button-agents');
    expect(agents.tagName).toBe('BUTTON');
    expect(agents.getAttribute('data-variant')).toBe('ghost');
    expect(agents.getAttribute('data-size')).toBe('icon-sm');
    expect(agents.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(agents.querySelector('svg')?.classList.contains('lucide-sparkles')).toBe(true);
  });

  test('pressed state follows whether the pane is on screen and flips when the store publishes', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    expect(agents.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: null });
    });

    expect(screen.getByRole('button', { name: 'Agents' })).toBe(agents);
    expect(agents.getAttribute('aria-pressed')).toBe('true');
  });

  test('a pane that is open but collapsed to zero size reads off, and a click asks to show it', async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    paneVisibilityStore.publish({ editor: null, agents: OPEN_OFF_SCREEN, terminal: null });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    expect(agents.getAttribute('aria-pressed')).toBe('false');
    expectVisualClassTokensAbsent(agents.className, PRESSED_LOOK);

    await user.click(agents);

    expect(requests).toEqual([{ pane: 'agents', open: true, reason: 'user' }]);
  });

  test('renders nothing, divider included, when the snapshot has no panes', () => {
    const { container } = renderButtons();

    expect(container.childElementCount).toBe(0);
    expect(screen.queryByTestId('header-pane-divider')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Panels' })).toBeNull();

    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    });
    expect(screen.getByTestId('header-pane-divider')).toBeTruthy();
  });

  test('a click asks for the opposite of the shown state and leaves focus on the button', async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: null });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    await user.click(agents);
    expect(document.activeElement).toBe(agents);

    expect(requests).toEqual([{ pane: 'agents', open: false, reason: 'user' }]);
  });

  test('hiding a pane keeps focus on the button even when the pane hands focus elsewhere as it hides', async () => {
    const user = userEvent.setup();
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: null });
    renderButtons();
    const elsewhere = document.createElement('div');
    elsewhere.tabIndex = -1;
    document.body.append(elsewhere);
    paneVisibilityStore.subscribeRequests(({ open }) => {
      if (!open) elsewhere.focus();
    });

    const agents = screen.getByRole('button', { name: 'Agents' });
    await user.click(agents);
    await act(async () => {});

    expect(document.activeElement).toBe(agents);
    elsewhere.remove();
  });

  test('each click acts on the state shown at that moment, not a local toggle', async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    await user.click(agents);
    await user.click(agents);
    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: null });
    });
    await user.click(agents);

    expect(requests.map(({ open }) => open)).toEqual([true, true, false]);
  });

  test('Enter and Space on a focused button send the same request as a click', async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: null });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    act(() => agents.focus());
    await user.keyboard('{Enter}');
    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    });
    await user.keyboard(' ');

    expect(requests).toEqual([
      { pane: 'agents', open: false, reason: 'user' },
      { pane: 'agents', open: true, reason: 'user' },
    ]);
    expect(document.activeElement).toBe(agents);
  });

  test.each([
    { platform: 'MacIntel', agents: '⌘ L' },
    { platform: 'Win32', agents: 'Ctrl L' },
    { platform: 'Linux x86_64', agents: 'Ctrl L' },
  ])(
    'the tooltip names the button and its $platform shortcut, the same in both states',
    async ({ platform, agents }) => {
      setPlatform(platform);
      const user = userEvent.setup();
      paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: null });
      renderButtons();

      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Agents' }));
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip.textContent).toBe(`Agents ${agents}`);
      expect(tooltip.querySelector('[data-slot="kbd"]')?.textContent).toBe(agents);

      act(() => {
        paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
      });
      expect((await screen.findByRole('tooltip')).textContent).toBe(`Agents ${agents}`);
    },
  );

  test('pressed buttons carry the tinted look, a hover tint of their own and a high-contrast outline', () => {
    paneVisibilityStore.publish({ editor: HIDDEN, agents: SHOWN, terminal: null });
    renderButtons();

    const on = screen.getByRole('button', { name: 'Agents' });
    const off = screen.getByRole('button', { name: 'Editor' });
    expectVisualClassTokens(on.className, [
      ...PRESSED_LOOK,
      ...PRESSED_HOVER_LOOK,
      ...HIGH_CONTRAST_OUTLINE,
    ]);
    expectVisualClassTokensAbsent(on.className, ['hover:bg-muted', 'text-muted-foreground']);
    expectVisualClassTokens(off.className, ['text-muted-foreground', 'hover:bg-muted']);
    expectVisualClassTokensAbsent(off.className, [
      ...PRESSED_LOOK,
      ...PRESSED_HOVER_LOOK,
      ...HIGH_CONTRAST_OUTLINE,
    ]);
  });

  test('with one pane shown at a time the buttons sit on one track with the shown pane raised, and a press on it asks for nothing', async () => {
    const user = userEvent.setup();
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: null }, true);
    const requests = recordRequests();
    renderButtons();

    const group = screen.getByRole('group', { name: 'Panels' });
    const shown = screen.getByRole('button', { name: 'Editor' });
    const idle = screen.getByRole('button', { name: 'Agents' });
    expectVisualClassTokens(group.className, SWITCHER_TRACK);
    expect(shown.getAttribute('aria-pressed')).toBe('true');
    expect(idle.getAttribute('aria-pressed')).toBe('false');
    expectVisualClassTokens(shown.className, [...RAISED_SEGMENT, ...HIGH_CONTRAST_OUTLINE]);
    expectVisualClassTokensAbsent(shown.className, PRESSED_LOOK);
    expectVisualClassTokensAbsent(idle.className, [...RAISED_SEGMENT, ...PRESSED_LOOK]);

    await user.click(shown);
    expect(requests).toEqual([]);
    await user.click(idle);
    expect(requests).toEqual([{ pane: 'agents', open: true, reason: 'user' }]);

    act(() => {
      paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: null }, false);
    });
    expectVisualClassTokensAbsent(group.className, SWITCHER_TRACK);
    expectVisualClassTokens(shown.className, PRESSED_LOOK);
    expectVisualClassTokensAbsent(shown.className, RAISED_SEGMENT);
  });

  test('useHeaderPaneButtonSet lists the panes to render in header order, never the terminal', () => {
    render(
      <Providers setting={TERMINAL_SETTING_UNSET}>
        <PaneSetProbe />
      </Providers>,
    );
    const probe = screen.getByTestId('pane-set');
    expect(probe.textContent).toBe('');

    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    });
    expect(probe.textContent).toBe('agents');

    act(() => {
      paneVisibilityStore.publish({ editor: SHOWN, agents: SHOWN, terminal: HIDDEN });
    });
    expect(probe.textContent).toBe('editor,agents');
  });
});

describe('the Editor header button', () => {
  afterEach(() => {
    __resetPaneVisibilityStoreForTests();
    setPlatform(ORIGINAL_PLATFORM);
  });

  test('a project window lists Editor first, then Agents', () => {
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: null });
    renderButtons();

    expect(paneButtonNames()).toEqual(['Editor', 'Agents']);
    const editor = screen.getByTestId('header-pane-button-editor');
    expect(editor.getAttribute('data-size')).toBe('icon-sm');
    expect(editor.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('no Editor button appears where the snapshot has no editor pane', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: HIDDEN });
    renderButtons();

    expect(screen.queryByRole('button', { name: 'Editor' })).toBeNull();
  });

  test('its pressed state follows whether the editor is shown and it keeps its name', () => {
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: null });
    renderButtons();
    const editor = screen.getByRole('button', { name: 'Editor' });
    expect(editor.getAttribute('aria-pressed')).toBe('true');
    expectVisualClassTokens(editor.className, PRESSED_LOOK);

    act(() => {
      paneVisibilityStore.publish({ editor: HIDDEN, agents: HIDDEN, terminal: null });
    });
    expect(editor.getAttribute('aria-pressed')).toBe('false');
    expect(editor.getAttribute('aria-label')).toBe('Editor');
    expectVisualClassTokensAbsent(editor.className, PRESSED_LOOK);
  });

  test('a click asks to hide a shown editor and show a hidden one, leaving focus on the button', async () => {
    const user = userEvent.setup();
    const requests: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((request) => requests.push(request));
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: null });
    renderButtons();
    const editor = screen.getByRole('button', { name: 'Editor' });

    await user.click(editor);
    act(() => {
      paneVisibilityStore.publish({ editor: HIDDEN, agents: HIDDEN, terminal: null });
    });
    await user.keyboard('{Enter}');

    expect(requests).toEqual([
      { pane: 'editor', open: false, reason: 'user' },
      { pane: 'editor', open: true, reason: 'user' },
    ]);
    expect(document.activeElement).toBe(editor);
  });

  test('its tooltip names it with no shortcut, on hover and on keyboard focus', async () => {
    setPlatform('MacIntel');
    const user = userEvent.setup();
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: null });
    renderButtons();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Editor' }));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe('Editor');
    expect(tooltip.querySelector('[data-slot="kbd"]')).toBeNull();
  });
});
