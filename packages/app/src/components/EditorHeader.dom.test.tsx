import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, type ReactNode, useEffect, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { ConfigContext } from '@/lib/config-context';
import { DEFAULT_DOCK_TREE, type DockNode } from '@/lib/dock-tree';
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

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

let activeDocName: string | null = 'docs/notes';
let sidebarState: 'expanded' | 'collapsed' = 'expanded';
let gitSyncStatus: Partial<GitSyncStatus> | null = null;
const syncToastsHookCalls: unknown[][] = [];
const syncToastsHosts = { mounted: 0 };
const gitSyncStatusReads = { count: 0 };

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName,
  }),
}));

vi.doMock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: sidebarState }),
  SidebarTrigger: ({ className, ...props }: ComponentProps<'button'>) => (
    <button type="button" data-testid="sidebar-trigger" className={className} {...props}>
      sidebar
    </button>
  ),
}));

vi.doMock('./SyncStatusBadge', async () => ({
  ...(await vi.importActual<typeof import('./SyncStatusBadge')>('./SyncStatusBadge')),
  SyncStatusBadge: () => <div data-testid="sync-status-badge" />,
}));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => {
    gitSyncStatusReads.count += 1;
    return { status: gitSyncStatus, fetchError: null };
  },
  useGitSyncStatus: () => gitSyncStatus,
}));

vi.doMock('@/presence/use-sync-toasts', () => ({
  useSyncToasts: (...args: unknown[]) => {
    syncToastsHookCalls.push(args);
    useEffect(() => {
      syncToastsHosts.mounted += 1;
      return () => {
        syncToastsHosts.mounted -= 1;
      };
    }, []);
  },
}));

vi.doMock('@/presence/PresenceBar', () => ({
  PresenceBar: () => <div data-testid="presence-bar" />,
}));

vi.doMock('./HelpPopover', () => ({
  HelpPopover: () => <button type="button">Resources</button>,
}));

const PANE_SHOWN: PaneVisibility = { open: true, onScreen: true };

function publishPanes() {
  act(() => {
    paneVisibilityStore.publish({ editor: null, agents: PANE_SHOWN });
  });
}

async function renderHeader(tabs?: ReactNode) {
  const { EditorHeader } = await import('./EditorHeader');
  const tree = (nextTabs?: ReactNode) => (
    <ConfigContext value={configContextFixture()}>
      <TooltipProvider delayDuration={0}>
        <EditorHeader>{nextTabs}</EditorHeader>
      </TooltipProvider>
    </ConfigContext>
  );
  render(tree(tabs));
  return document.querySelector('header') as HTMLElement;
}

async function renderMeasuredHeader() {
  return await renderHeader(<div>tabs</div>);
}

describe('EditorHeader runtime behavior', () => {
  afterEach(() => {
    cleanup();
    activeDocName = 'docs/notes';
    sidebarState = 'expanded';
    gitSyncStatus = null;
    syncToastsHookCalls.length = 0;
    syncToastsHosts.mounted = 0;
    gitSyncStatusReads.count = 0;
    __resetPaneVisibilityStoreForTests();
  });

  test('exports the EditorHeader component', async () => {
    const mod = await import('./EditorHeader');
    expect(typeof mod.EditorHeader).toBe('function');
  });

  test('a project window tab row is a plain 44px row', async () => {
    sidebarState = 'collapsed';
    const header = await renderHeader();

    expectVisualClassTokens(header.className, [
      'flex',
      'h-11',
      'shrink-0',
      'items-center',
      'bg-background',
    ]);
    expectVisualClassTokensAbsent(header.className, ['shadow-[inset_0_-1px_0_var(--border)]']);
  });

  test('tabs paint on the first render, with no header chrome to measure first', async () => {
    const { EditorHeader } = await import('./EditorHeader');
    const markup = renderToStaticMarkup(
      <TooltipProvider delayDuration={0}>
        <EditorHeader>
          <div>restored tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const container = document.createElement('div');
    container.innerHTML = markup;
    const tabHost = container.querySelector('[data-editor-header-tabs]') as HTMLElement;

    expectVisualClassTokensAbsent(tabHost.className, ['invisible']);
    expect(tabHost.hasAttribute('data-editor-header-tabs-suppressed')).toBe(false);
  });

  test('the tab strip is bounded by the editor column width, not padded around header chrome', async () => {
    const header = await renderHeader(<div>tabs</div>);
    const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;

    expectVisualClassTokens(tabHost.className, [
      'w-[var(--editor-header-tabs-width,100%)]',
      'min-w-0',
      'overflow-hidden',
    ]);
    expectVisualClassTokensAbsent(tabHost.className, ['absolute', 'invisible']);
  });

  test('a project window tab row carries none of the header actions, which moved to the app header', async () => {
    gitSyncStatus = { state: 'idle', conflictCount: 2, hasRemote: true };
    for (const state of ['expanded', 'collapsed'] as const) {
      sidebarState = state;
      await renderMeasuredHeader();

      expect(screen.queryByTestId('presence-bar')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Share/ })).toBeNull();
      expect(screen.queryByTestId('sync-status-badge')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Resources' })).toBeNull();
      expect(screen.queryByTestId('beta-badge')).toBeNull();
      expect(screen.queryByTestId('instance-badge')).toBeNull();
      expect(screen.queryByTestId('header-overflow-actions-trigger')).toBeNull();
      expect(syncToastsHosts.mounted).toBe(0);
      cleanup();
    }
  });

  test('document card headers leave sync status to the shared header', async () => {
    gitSyncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };

    await renderHeader();
    expect(gitSyncStatusReads.count).toBe(0);
  });

  test('a project window tab row leaves the Agents button to the app header', async () => {
    publishPanes();
    const header = await renderHeader(<div>tabs</div>);

    expect(header.querySelector('[data-testid="header-pane-buttons"]')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Panels' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
  });

  test('dragging the tab row onto the middle of the Agents panel trades the editor and the Agents panel', async () => {
    const { DockWorkspace } = await import('./DockWorkspace');
    const { EditorHeader } = await import('./EditorHeader');
    const rects = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const [width, height] = this.hasAttribute('data-dock-workspace') ? [1200, 800] : [0, 0];
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: height,
          width,
          height,
          toJSON() {},
        } as DOMRect;
      });
    onTestFinished(() => rects.mockRestore());
    function Workspace() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return (
        <ConfigContext value={configContextFixture()}>
          <TooltipProvider delayDuration={0}>
            <DockWorkspace
              tree={tree}
              visible={{ editor: true, agents: true }}
              units={{
                editor: (
                  <EditorHeader>
                    <div data-testid="editor-tabs">tabs</div>
                  </EditorHeader>
                ),
                agents: <div>Agents</div>,
              }}
              gap={8}
              minExtent={() => ({ width: 100, height: 100 })}
              paneLabel={(pane) => pane}
              onTreeChange={setTree}
              redockable
            />
          </TooltipProvider>
        </ConfigContext>
      );
    }
    render(<Workspace />);
    const placed = (pane: string) => {
      const style = document.querySelector<HTMLElement>(`[data-dock-unit="${pane}"]`)?.style;
      return {
        start: Number.parseFloat(style?.insetInlineStart ?? ''),
        top: Number.parseFloat(style?.insetBlockStart ?? ''),
        width: Number.parseFloat(style?.width ?? ''),
        height: Number.parseFloat(style?.height ?? ''),
      };
    };
    const editor = placed('editor');
    const agents = placed('agents');
    expect(editor.width).toBeGreaterThan(0);
    expect(agents.start).toBeGreaterThan(editor.start);
    const middle = {
      clientX: agents.start + agents.width / 2,
      clientY: agents.top + agents.height / 2,
    };
    const tabs = screen.getByTestId('editor-tabs');

    fireEvent.pointerDown(tabs, { button: 0, buttons: 1, pointerId: 3, clientX: 20, clientY: 10 });
    fireEvent.pointerMove(tabs, { buttons: 1, pointerId: 3, ...middle });
    fireEvent.pointerUp(tabs, { pointerId: 3, ...middle });

    expect(placed('editor')).toEqual(agents);
    expect(placed('agents')).toEqual(editor);
  });

  test('renders workspace tabs between the global action zones', async () => {
    await renderHeader(<div data-testid="editor-tabs">tabs</div>);

    const tabHost = document.querySelector('[data-editor-header-tabs]');
    expect(tabHost?.contains(screen.getByTestId('editor-tabs'))).toBe(true);
    expect(screen.queryByTestId('open-in-agent-menu')).toBeNull();
    expect(screen.queryByText('projectName')).toBeNull();
    expect(screen.queryByText('assetFileName')).toBeNull();
  });

  test('a project window tab row shows its trailing slot only while the row is at least 240px wide', async () => {
    const { EditorHeader } = await import('./EditorHeader');
    render(
      <TooltipProvider delayDuration={0}>
        <EditorHeader trailing={<button type="button">toggle</button>}>
          <div data-testid="editor-tabs">tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const header = document.querySelector('header') as HTMLElement;
    const trailing = header.querySelector('[data-editor-header-trailing]') as HTMLElement;

    expect(trailing.contains(screen.getByRole('button', { name: 'toggle' }))).toBe(true);
    expectVisualClassTokens(header.className, ['@container/editor-header']);
    expectVisualClassTokens(trailing.className, ['hidden', '@[15rem]/editor-header:flex']);
    expectVisualClassTokensAbsent(trailing.className, ['flex']);
  });

  test('a project window tab row tells the last tab group how wide its trailing slot is, only while the slot shows', async () => {
    const { EditorHeader } = await import('./EditorHeader');
    const view = render(
      <TooltipProvider delayDuration={0}>
        <EditorHeader trailing={<button type="button">toggle</button>}>
          <div data-testid="editor-tabs">tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const header = document.querySelector('header') as HTMLElement;
    const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;
    expectVisualClassTokens(tabHost.className, [
      '@[15rem]/editor-header:[--editor-header-trailing-width:2rem]',
    ]);
    expect(header.className).not.toContain('--editor-header-trailing-width');
    expect(header.style.getPropertyValue('--editor-header-trailing-width')).toBe('');
    view.unmount();

    render(
      <TooltipProvider delayDuration={0}>
        <EditorHeader>
          <div data-testid="editor-tabs">tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const bare = document.querySelector('[data-editor-header-tabs]') as HTMLElement;
    expect(bare.className).not.toContain('--editor-header-trailing-width');
  });
});
