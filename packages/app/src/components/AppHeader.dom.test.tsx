import { resetParseHealth } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { APP_HEADER_HEIGHT, AppHeader } from '@/components/AppHeader';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { ConfigContext } from '@/lib/config-context';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneVisibility,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import { configContextFixture } from '@/test-utils/config-context';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

const searchRender = vi.hoisted(() => ({ throws: false }));
const shell = vi.hoisted(() => ({
  singleFile: false,
  activeDocName: 'docs/notes' as string | null,
  activeTarget: { kind: 'doc' } as unknown,
  syncStatus: null as Partial<GitSyncStatus> | null,
  syncToastHosts: 0,
}));

vi.mock('@/lib/single-file-mode', () => ({
  useSingleFileMode: () => shell.singleFile,
}));

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: shell.activeDocName,
    activeTarget: shell.activeTarget,
    activeProvider: null,
  }),
}));

vi.mock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({ status: shell.syncStatus, fetchError: null }),
  useGitSyncStatus: () => shell.syncStatus,
}));

vi.mock('@/presence/use-sync-toasts', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    useSyncToasts: () => {
      useEffect(() => {
        shell.syncToastHosts += 1;
        return () => {
          shell.syncToastHosts -= 1;
        };
      }, []);
    },
  };
});

vi.mock('@/presence/PresenceBar', () => ({
  PresenceBar: () => <div data-testid="presence-bar" />,
}));

vi.mock('@/components/SyncStatusBadge', async () => ({
  ...(await vi.importActual<typeof import('@/components/SyncStatusBadge')>(
    '@/components/SyncStatusBadge',
  )),
  SyncStatusBadge: () => <div data-testid="sync-status-badge" />,
}));

vi.mock('@/components/HelpPopover', () => ({
  HelpPopover: () => <button type="button">Resources</button>,
}));

vi.mock('@/components/PublishToGitHubDialog', () => ({
  PublishToGitHubDialog: ({ open }: { open: boolean }) => (
    <div data-testid="publish-dialog" data-open={String(open)} />
  ),
}));

vi.mock('@/components/HeaderSearchBar', async () => {
  const actual = await vi.importActual<typeof import('@/components/HeaderSearchBar')>(
    '@/components/HeaderSearchBar',
  );
  return {
    ...actual,
    HeaderSearchBar: (props: ComponentProps<typeof actual.HeaderSearchBar>) => {
      if (searchRender.throws) throw new Error('search button render failed');
      return <actual.HeaderSearchBar {...props} />;
    },
  };
});

interface DesktopHostOptions {
  platform?: string;
  channel?: 'latest' | 'beta';
  instanceLabel?: string;
  menu?: { dispatch: (request: { kind: string }) => Promise<unknown> };
}

function setElectronHost(
  enabled: boolean,
  { platform, channel = 'latest', instanceLabel, menu }: DesktopHostOptions = {},
) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: enabled
      ? {
          platform,
          instanceLabel,
          menu,
          config: {
            mode: 'editor',
            projectName: 'Field Notes',
            projectPath: '/projects/field-notes',
          },
          state: { query: () => Promise.resolve({ channel }) },
          project: { listRecent: () => Promise.resolve([]) },
          worktree: { list: () => Promise.resolve({ ok: false, reason: 'no-git' }) },
        }
      : undefined,
  });
}

const onOpenSearch = vi.fn(() => {});

function HeaderProviders({ children }: { children: ReactNode }) {
  return (
    <ConfigContext value={configContextFixture()}>
      <TooltipProvider>{children}</TooltipProvider>
    </ConfigContext>
  );
}

function renderHeader() {
  return render(<AppHeader onOpenSearch={onOpenSearch} />, { wrapper: HeaderProviders });
}

function centreGroup(): HTMLElement {
  return screen.getByRole('banner').querySelector('[data-app-header-center]') as HTMLElement;
}

function leadingGroup(): HTMLElement {
  return screen.getByRole('banner').querySelector('[data-app-header-leading]') as HTMLElement;
}

function trailingGroup(): HTMLElement {
  return screen.getByRole('banner').querySelector('[data-app-header-trailing]') as HTMLElement;
}

interface HeaderMetrics {
  header: number;
  leading: number;
  compactBadgeLeading?: number;
  badgeLabel?: number;
  badges?: { beta?: number; instance?: number };
  trailing: number;
  collapsedTrailing?: number;
  paneButton?: number;
  switcher?: number;
  switcherName?: number;
}

function mockHeaderMetrics(source: HeaderMetrics | (() => HeaderMetrics)) {
  const read = typeof source === 'function' ? source : () => source;
  const scrollWidth = vi
    .spyOn(Element.prototype, 'scrollWidth', 'get')
    .mockImplementation(function (this: Element) {
      const metrics = read();
      return this.hasAttribute('data-instance-badge-label') ? (metrics.badgeLabel ?? 0) : 0;
    });
  const offsetWidth = vi
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function (this: HTMLElement) {
      const metrics = read();
      if (this.hasAttribute('data-app-header')) return metrics.header;
      if (this.hasAttribute('data-app-header-leading')) {
        const badgeCompact = this.querySelector('[data-instance-badge-label].sr-only') !== null;
        const width =
          badgeCompact && metrics.compactBadgeLeading !== undefined
            ? metrics.compactBadgeLeading
            : metrics.leading;
        let foldedAway = 0;
        if (this.querySelector('[data-testid="beta-badge"]') === null) {
          foldedAway += metrics.badges?.beta ?? 0;
        }
        if (this.querySelector('[data-testid="instance-badge"]') === null) {
          foldedAway += metrics.badges?.instance ?? 0;
        }
        return width - foldedAway;
      }
      if (this.hasAttribute('data-app-header-badges')) {
        let width = 0;
        if (this.querySelector('[data-testid="beta-badge"]') !== null) {
          width += metrics.badges?.beta ?? 0;
        }
        if (this.querySelector('[data-testid="instance-badge"]') !== null) {
          const compact = this.querySelector('[data-instance-badge-label].sr-only') !== null;
          width += (metrics.badges?.instance ?? 0) - (compact ? (metrics.badgeLabel ?? 0) : 0);
        }
        return width;
      }
      if (this.hasAttribute('data-app-header-trailing')) {
        const collapsed =
          this.querySelector('[data-testid="header-overflow-actions-trigger"]') !== null;
        const paneRow =
          this.querySelectorAll('[data-testid^="header-pane-button-"]').length *
          (metrics.paneButton ?? 0);
        return (
          (collapsed && metrics.collapsedTrailing !== undefined
            ? metrics.collapsedTrailing
            : metrics.trailing) + paneRow
        );
      }
      if (this.getAttribute('data-testid') === 'project-switcher-trigger') {
        return metrics.switcher ?? 0;
      }
      if (this.getAttribute('data-testid') === 'project-switcher-name') {
        return metrics.switcherName ?? 0;
      }
      return 0;
    });
  return () => {
    offsetWidth.mockRestore();
    scrollWidth.mockRestore();
  };
}

function captureResizeObserver() {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
  const original = globalThis.ResizeObserver;
  class CapturingResizeObserver {
    private readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set<Element>() };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      this.entry.targets.clear();
    }
  }
  globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
  return {
    flush(target?: Element) {
      for (const { callback, targets } of observers) {
        if (target !== undefined && !targets.has(target)) continue;
        act(() => {
          callback([], {} as ResizeObserver);
        });
      }
    },
    restore() {
      globalThis.ResizeObserver = original;
    },
  };
}

function overflowTrigger(): HTMLElement | null {
  return screen.queryByTestId('header-overflow-actions-trigger');
}

async function openOverflowPanel(): Promise<HTMLElement> {
  await userEvent.click(screen.getByTestId('header-overflow-actions-trigger'));
  return await waitFor(() => {
    const panel = document.querySelector('[data-header-overflow-actions]');
    expect(panel, 'the overflow trigger must open a panel').not.toBeNull();
    return panel as HTMLElement;
  });
}

const TRAILING_ACTION_QUERIES = [
  () => screen.queryByTestId('presence-bar'),
  () => screen.queryByRole('button', { name: /^Share / }),
  () => screen.queryByTestId('sync-status-badge'),
  () => screen.queryByRole('button', { name: 'Settings' }),
  () => screen.queryByRole('button', { name: 'Resources' }),
] as const;

const PANE_HIDDEN: PaneVisibility = { open: false, onScreen: false };

function publishPanes() {
  act(() => {
    paneVisibilityStore.publish({ editor: null, agents: PANE_HIDDEN });
  });
}

function paneControls(): HTMLElement[] {
  return [
    screen.getByTestId('header-pane-divider'),
    screen.getByRole('button', { name: 'Agents' }),
  ];
}

const CRAMPED: HeaderMetrics = { header: 600, leading: 220, trailing: 420, collapsedTrailing: 44 };
const ROOMY: HeaderMetrics = { header: 1_280, leading: 220, trailing: 420 };

function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

afterEach(() => {
  cleanup();
  setElectronHost(false);
  onOpenSearch.mockClear();
  searchRender.throws = false;
  shell.activeDocName = 'docs/notes';
  shell.activeTarget = { kind: 'doc' };
  shell.syncStatus = null;
  shell.syncToastHosts = 0;
  shell.singleFile = false;
  __resetPaneVisibilityStoreForTests();
  vi.unstubAllGlobals();
});

describe('AppHeader', () => {
  test('a single-file window keeps global actions and the component selector above its cards', async () => {
    shell.singleFile = true;
    setElectronHost(true, { platform: 'win32', menu: { dispatch: async () => null } });
    act(() => {
      paneVisibilityStore.publish({
        editor: { open: true, onScreen: true },
        agents: PANE_HIDDEN,
      });
    });
    renderHeader();

    expect(screen.getByRole('banner', { name: 'Application' })).toBeTruthy();
    expect(screen.getByTestId('presence-bar')).toBeTruthy();
    expect(screen.getByTestId('sync-status-badge')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resources' })).toBeTruthy();
    expect(await screen.findByTestId('app-menubar')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Panels' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editor' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy();
    expect(screen.queryByTestId('project-switcher-trigger')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Search/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Share/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(screen.queryByTestId('publish-dialog')).toBeNull();
    expect(screen.queryByTestId('navigation-history-controls')).toBeNull();
  });

  test('a narrow single-file header folds secondary actions while keeping the selector visible', async () => {
    shell.singleFile = true;
    setElectronHost(true, { platform: 'win32' });
    publishPanes();
    const restoreMetrics = mockHeaderMetrics(CRAMPED);
    try {
      renderHeader();
      const trailing = trailingGroup();
      const trigger = screen.getByTestId('header-overflow-actions-trigger');
      const selector = screen.getByRole('group', { name: 'Panels' });
      expect(trailing.contains(selector)).toBe(true);
      expect(follows(trigger, selector)).toBe(true);
      const panel = await openOverflowPanel();
      expect(panel.contains(screen.getByRole('button', { name: 'Resources' }))).toBe(true);
      expect(panel.querySelector('[data-testid="presence-bar"]')).not.toBeNull();
      expect(panel.querySelector('[data-testid="sync-status-badge"]')).not.toBeNull();
      expect(panel.contains(selector)).toBe(false);
    } finally {
      restoreMetrics();
    }
  });

  test('exposes a single banner landmark with an accessible name', () => {
    renderHeader();

    const banners = screen.getAllByRole('banner');
    expect(banners).toHaveLength(1);
    expect(screen.getByRole('banner', { name: 'Application' })).toBe(banners[0]);
  });

  test('lays out a leading, centre and trailing group in reading order', () => {
    renderHeader();

    const header = screen.getByRole('banner');
    const groups = Array.from(header.children).map((child) =>
      child.getAttributeNames().find((name) => name.startsWith('data-app-header-')),
    );

    expect(groups).toEqual([
      'data-app-header-leading',
      'data-app-header-center',
      'data-app-header-trailing',
    ]);
  });

  test('takes its height from the app-header height property the shell publishes', () => {
    renderHeader();

    expectVisualClassTokens(screen.getByRole('banner').className, [
      `h-[var(--ok-app-header-height,${APP_HEADER_HEIGHT})]`,
    ]);
  });

  test('paints the shell chrome surface with no rule under it', () => {
    renderHeader();

    const header = screen.getByRole('banner');
    expectVisualClassTokens(header.className, ['bg-desk']);
    expectVisualClassTokensAbsent(header.className, [
      'bg-background',
      'shadow-[inset_0_-1px_0_var(--border)]',
    ]);
  });

  test('reserves the macOS window buttons plus a 10px gap at its leading edge', () => {
    renderHeader();

    expectVisualClassTokens(leadingGroup().className, [
      'ps-[calc(var(--ok-titlebar-reserve-left,0px)+0.625rem)]',
    ]);
  });

  test('on Electron the pane buttons opt out of dragging and the divider beside them stays draggable', () => {
    setElectronHost(true);
    publishPanes();
    renderHeader();

    const header = screen.getByRole('banner');
    for (const name of ['Agents']) {
      const button = screen.getByRole('button', { name });
      expect(header.contains(button)).toBe(true);
      expect(button.tagName, `${name} must be a <button> for the header's no-drag rule`).toBe(
        'BUTTON',
      );
    }
    const divider = screen.getByTestId('header-pane-divider');
    expect(header.contains(divider)).toBe(true);
    for (
      let node: HTMLElement | null = divider;
      node && node !== header;
      node = node.parentElement
    ) {
      expect(['BUTTON', 'A']).not.toContain(node.tagName);
      expectVisualClassTokensAbsent(node.className, ['[-webkit-app-region:no-drag]']);
    }
  });

  test('claims no drag region on a web host', () => {
    renderHeader();

    const header = screen.getByRole('banner');
    expect(header.getAttribute('data-electron-drag')).toBeNull();
    expectVisualClassTokensAbsent(header.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokensAbsent(header.querySelector('[data-app-header-trailing]')?.className, [
      'me-[var(--ok-titlebar-reserve-right,0px)]',
    ]);
  });

  describe('leading group', () => {
    test('a web host gets search alone, with no navigation history', () => {
      renderHeader();

      expect(leadingGroup().contains(screen.getByRole('button', { name: 'Search' }))).toBe(true);
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
    });

    test('search opens the command palette and keeps its shortcut hint', async () => {
      const user = userEvent.setup();
      renderHeader();

      const search = screen.getByRole('button', { name: 'Search' });
      await user.hover(search);
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip.querySelector('[data-slot="kbd"]')).not.toBeNull();

      await user.click(search);
      expect(onOpenSearch).toHaveBeenCalledTimes(1);
    });

    test('macOS leaves the app menu to the native menu bar', async () => {
      setElectronHost(true, {
        platform: 'darwin',
        menu: { dispatch: () => Promise.resolve(null) },
      });
      renderHeader();

      await screen.findByRole('button', { name: 'Search' });
      expect(screen.queryByTestId('app-menubar')).toBeNull();
    });

    test('the search button comes back once the open document changes', () => {
      resetParseHealth();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      searchRender.throws = true;
      setElectronHost(true);
      try {
        const rendered = renderHeader();
        expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();

        searchRender.throws = false;
        shell.activeDocName = 'docs/other';
        rendered.rerender(<AppHeader onOpenSearch={onOpenSearch} />);

        expect(
          screen.queryByRole('button', { name: 'Search' }),
          'one render failure removed the search button for the life of the window',
        ).not.toBeNull();
      } finally {
        consoleError.mockRestore();
        consoleWarn.mockRestore();
      }
    });
  });

  describe('centre track', () => {
    test('stays empty on a web host', () => {
      renderHeader();

      expect(centreGroup().children).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Open project menu' })).toBeNull();
    });
  });

  describe('trailing group', () => {
    test('holds presence, Share, sync, settings and resources, then a divider and the Agents button, in that order', () => {
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      publishPanes();
      renderHeader();

      const controls = [...TRAILING_ACTION_QUERIES.map((query) => query()), ...paneControls()];
      for (const control of controls) {
        expect(control).not.toBeNull();
        expect(trailingGroup().contains(control)).toBe(true);
      }
      for (let index = 1; index < controls.length; index += 1) {
        expect(follows(controls[index - 1] as Element, controls[index] as Element)).toBe(true);
      }
    });

    test('Share opens the publish dialog from the header when the project has no remote', async () => {
      const user = userEvent.setup();
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: false };
      renderHeader();

      expect(screen.getByTestId('publish-dialog').getAttribute('data-open')).toBe('false');
      await user.click(screen.getByRole('button', { name: 'Share doc' }));

      expect(screen.getByTestId('publish-dialog').getAttribute('data-open')).toBe('true');
      expect(trailingGroup().contains(screen.getByTestId('publish-dialog'))).toBe(true);
    });

    test.each([
      {
        target: 'an open doc',
        activeDocName: 'docs/notes',
        activeTarget: { kind: 'doc' },
        button: 'Share doc',
        request: { kind: 'doc', docPath: 'docs/notes.md' },
      },
      {
        target: 'a selected folder',
        activeDocName: null,
        activeTarget: { kind: 'folder', folderPath: 'guides' },
        button: 'Share folder',
        request: { kind: 'folder', folderPath: 'guides' },
      },
      {
        target: 'nothing open or selected',
        activeDocName: null,
        activeTarget: null,
        button: 'Share folder',
        request: { kind: 'folder', folderPath: '' },
      },
    ])(
      'Share asks for a link to $target',
      async ({ activeDocName, activeTarget, button, request }) => {
        const user = userEvent.setup();
        const requests: unknown[] = [];
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, init?: RequestInit) => {
            requests.push(JSON.parse(String(init?.body)));
            return new Response('unavailable', { status: 503 });
          }),
        );
        shell.activeDocName = activeDocName;
        shell.activeTarget = activeTarget;
        shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
        renderHeader();

        await user.click(screen.getByRole('button', { name: button }));

        await waitFor(() => expect(requests).toEqual([request]));
      },
    );

    test.each([
      {
        target: 'an asset',
        activeDocName: null,
        activeTarget: { kind: 'asset', assetPath: 'img/logo.png' },
      },
    ])('Share stays disabled for $target', ({ activeDocName, activeTarget }) => {
      shell.activeDocName = activeDocName;
      shell.activeTarget = activeTarget;
      renderHeader();

      const share = within(trailingGroup()).getByRole('button', { name: /^Share / });
      expect((share as HTMLButtonElement).disabled).toBe(true);
    });

    test('mounts the sync-toast machine exactly once, outside the collapsible group', () => {
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();

        expect(overflowTrigger()).not.toBeNull();
        expect(screen.queryByTestId('presence-bar')).toBeNull();
        expect(shell.syncToastHosts).toBe(1);
      } finally {
        restoreMetrics();
      }
    });
  });

  describe('collapse', () => {
    test('the panel behind "More actions" is a dialog announced by that name, even while sync needs attention', async () => {
      shell.syncStatus = { state: 'conflict', conflictCount: 1, hasRemote: true };
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();

        const panel = await openOverflowPanel();
        expect(screen.getByRole('dialog', { name: 'More actions' })).toBe(panel);
      } finally {
        restoreMetrics();
      }
    });

    test('when folded, the divider and the pane buttons stay in the header after "More actions" and out of its panel, and keep their place when room returns', async () => {
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      publishPanes();
      const observer = captureResizeObserver();
      let restoreMetrics = mockHeaderMetrics({ ...CRAMPED, paneButton: 28 });
      try {
        renderHeader();

        const trigger = overflowTrigger() as HTMLElement;
        expect(trigger).not.toBeNull();
        for (const control of paneControls()) {
          expect(trailingGroup().contains(control)).toBe(true);
          expect(follows(trigger, control)).toBe(true);
        }
        const panel = await openOverflowPanel();
        for (const query of TRAILING_ACTION_QUERIES) {
          expect(panel.contains(query())).toBe(true);
        }
        for (const control of paneControls()) {
          expect(panel.contains(control)).toBe(false);
        }

        restoreMetrics();
        restoreMetrics = mockHeaderMetrics({ ...ROOMY, paneButton: 28 });
        observer.flush();

        expect(overflowTrigger()).toBeNull();
        const controls = [...TRAILING_ACTION_QUERIES.map((query) => query()), ...paneControls()];
        for (const control of controls) {
          expect(trailingGroup().contains(control)).toBe(true);
        }
        for (let index = 1; index < controls.length; index += 1) {
          expect(follows(controls[index - 1] as Element, controls[index] as Element)).toBe(true);
        }
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('when room returns the five come back out and the trigger goes', () => {
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      const observer = captureResizeObserver();
      let restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();
        expect(overflowTrigger()).not.toBeNull();

        restoreMetrics();
        restoreMetrics = mockHeaderMetrics(ROOMY);
        observer.flush();

        expect(overflowTrigger()).toBeNull();
        for (const query of TRAILING_ACTION_QUERIES) {
          expect(trailingGroup().contains(query())).toBe(true);
        }
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('keeps the trailing group inline when it fits', () => {
      const restoreMetrics = mockHeaderMetrics(ROOMY);
      try {
        renderHeader();

        expect(overflowTrigger()).toBeNull();
        expect(trailingGroup().contains(screen.getByRole('button', { name: 'Settings' }))).toBe(
          true,
        );
      } finally {
        restoreMetrics();
      }
    });

    test('never collapses while the header is unmeasured', () => {
      const restoreMetrics = mockHeaderMetrics({ ...CRAMPED, header: 0 });
      try {
        renderHeader();

        expect(overflowTrigger()).toBeNull();
      } finally {
        restoreMetrics();
      }
    });

    test('a group that fits beside the leading group and the switcher icons stays inline', () => {
      setElectronHost(true);
      const restoreMetrics = mockHeaderMetrics({
        header: 760,
        leading: 220,
        trailing: 420,
        switcher: 464,
        switcherName: 400,
      });
      try {
        renderHeader();

        expect(overflowTrigger()).toBeNull();
      } finally {
        restoreMetrics();
      }
    });

    test('counts the Windows caption-button inset against the room', () => {
      setElectronHost(true, { platform: 'win32' });
      const realGetComputedStyle = window.getComputedStyle.bind(window);
      const computedStyle = vi
        .spyOn(window, 'getComputedStyle')
        .mockImplementation((element: Element, pseudo?: string | null) => {
          const style = realGetComputedStyle(element, pseudo);
          if (element instanceof HTMLElement && element.hasAttribute('data-app-header-trailing')) {
            return new Proxy(style, {
              get: (target, property) =>
                property === 'marginInlineEnd' ? '138px' : Reflect.get(target, property),
            }) as CSSStyleDeclaration;
          }
          return style;
        });
      const restoreMetrics = mockHeaderMetrics({ header: 760, leading: 220, trailing: 420 });
      try {
        renderHeader();

        expect(
          overflowTrigger(),
          '420px of controls plus a 138px caption-button inset does not fit in 540px',
        ).not.toBeNull();
      } finally {
        restoreMetrics();
        computedStyle.mockRestore();
      }
    });

    test('a collapsed group stays collapsed when its own collapsed width is re-measured', () => {
      const observer = captureResizeObserver();
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();
        expect(overflowTrigger()).not.toBeNull();

        for (const pass of [1, 2, 3]) {
          observer.flush();
          expect(
            overflowTrigger(),
            `re-measurement pass ${pass} re-expanded the group though the room never changed`,
          ).not.toBeNull();
        }
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('re-measures the remembered width when the trailing content changes', async () => {
      const observer = captureResizeObserver();
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      let restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        const view = renderHeader();
        expect(overflowTrigger()).not.toBeNull();

        restoreMetrics();
        restoreMetrics = mockHeaderMetrics({ ...CRAMPED, trailing: 200 });
        shell.syncStatus = { state: 'offline', conflictCount: 0, hasRemote: true };
        view.rerender(<AppHeader onOpenSearch={onOpenSearch} />);

        await waitFor(() => expect(overflowTrigger()).toBeNull());
        observer.flush();
        expect(overflowTrigger()).toBeNull();
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test.each([
      { status: { state: 'idle', conflictCount: 2 }, attention: 'conflict', label: 'Conflict' },
      { status: { state: 'offline', conflictCount: 0 }, attention: 'offline', label: 'Offline' },
      {
        status: { state: 'auth-error', conflictCount: 0 },
        attention: 'auth-error',
        label: 'Reconnect required',
      },
      {
        status: { state: 'disabled', conflictCount: 0, pausedReason: 'git-operation-in-progress' },
        attention: 'paused',
        label: 'Sync paused',
      },
    ] as const)(
      'a collapsed group puts the $attention sync state on the trigger',
      ({ status, attention, label }) => {
        shell.syncStatus = { ...status, hasRemote: true } as Partial<GitSyncStatus>;
        const restoreMetrics = mockHeaderMetrics(CRAMPED);
        try {
          renderHeader();

          const trigger = overflowTrigger() as HTMLElement;
          expect(trigger.getAttribute('aria-label')).toBe(`More actions (${label})`);
          expect(
            trigger
              .querySelector('[data-testid="header-overflow-actions-sync-indicator"]')
              ?.getAttribute('data-sync-attention'),
          ).toBe(attention);
        } finally {
          restoreMetrics();
        }
      },
    );

    test('a collapsed group leaves the trigger unadorned while sync is healthy', () => {
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();

        const trigger = overflowTrigger() as HTMLElement;
        expect(trigger.getAttribute('aria-label')).toBe('More actions');
        expect(
          trigger.querySelector('[data-testid="header-overflow-actions-sync-indicator"]'),
        ).toBeNull();
      } finally {
        restoreMetrics();
      }
    });
  });
});
