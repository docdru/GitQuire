import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetPaneVisibilityStoreForTests } from '@/lib/pane-visibility-store';
import type { ResolvedNavigationTarget } from './navigation-targets';

function PassThrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function ElementPassThrough({
  children,
  asChild: _asChild,
  ...props
}: {
  children?: ReactNode;
  asChild?: boolean;
  [key: string]: unknown;
}) {
  return <div {...props}>{children}</div>;
}

function Button({
  children,
  asChild: _asChild,
  onCheckedChange: _onCheckedChange,
  size: _size,
  variant: _variant,
  ...props
}: {
  children?: ReactNode;
  asChild?: boolean;
  onCheckedChange?: unknown;
  size?: unknown;
  variant?: unknown;
  [key: string]: unknown;
}) {
  return (
    <button type="button" {...props}>
      {children}
    </button>
  );
}

const ACTIVE_TARGET = {
  kind: 'doc',
  target: 'notes/source',
  docName: 'notes/source',
} satisfies ResolvedNavigationTarget;
let activeTarget: ResolvedNavigationTarget | null = ACTIVE_TARGET;

const toggleSidebarMock = vi.fn(() => {});
const treeCalls = {
  collapseAll: vi.fn(() => {}),
  expandAll: vi.fn(() => {}),
  startCreating: vi.fn((_kind: 'file' | 'folder', _parentDir: string) => {}),
  startCreatingFromTemplate: vi.fn((_parentDir: string) => {}),
};
const projectLocalPatch = vi.fn((_patch: unknown) => ({ ok: true as const }));
const projectLocalBindingStub = { patch: projectLocalPatch };
const DEFAULT_MERGED_CONFIG = { appearance: { sidebar: { showHiddenFiles: false } } };
let mergedConfig: { appearance?: { sidebar?: Record<string, boolean> } } = DEFAULT_MERGED_CONFIG;
let projectLocalSynced = true;

vi.doMock('@/lib/perf', () => ({
  ProfilerBoundary: PassThrough,
}));

vi.doMock('@/components/FileTree', () => ({
  FileTree: ({ ref }: { ref?: (handle: unknown) => void }) => {
    useEffect(() => {
      const handle = {
        collapseAll: treeCalls.collapseAll,
        expandAll: treeCalls.expandAll,
        getFolderState: () => ({ folderCount: 2, expandedCount: 1 }),
        isCreationTargetCleared: () => false,
        startCreating: treeCalls.startCreating,
        startCreatingFromTemplate: treeCalls.startCreatingFromTemplate,
        subscribe: () => () => {},
      };
      ref?.(handle);
      return () => ref?.(null);
    }, [ref]);
    return <div data-testid="file-tree-stub" />;
  },
}));

vi.doMock('@/components/ConflictsSection', () => ({
  ConflictsSection: () => null,
}));

vi.doMock('@/components/ui/button', () => ({
  Button,
}));

vi.doMock('@/components/ui/sidebar', () => ({
  Sidebar: ElementPassThrough,
  SidebarContent: ElementPassThrough,
  SidebarFooter: ElementPassThrough,
  SidebarHeader: ElementPassThrough,
  SidebarMenu: ElementPassThrough,
  SidebarMenuItem: ElementPassThrough,
  SidebarGroup: ElementPassThrough,
  SidebarGroupContent: ElementPassThrough,
  SidebarGroupLabel: ElementPassThrough,
  SidebarRail: () => null,
  useSidebar: () => ({ state: 'expanded', toggleSidebar: toggleSidebarMock }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'notes/source',
    activeTarget,
  }),
  isBlobRunnerNewTabId: () => false,
}));

vi.doMock('@/hooks/use-folder-config', () => ({
  useFolderConfig: () => ({
    state: {
      status: 'ready',
      data: { folder: { templates_available: [] } },
    },
  }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalBinding: projectLocalBindingStub,
    projectLocalSynced,
    merged: mergedConfig,
  }),
}));

const workspaceStub = {
  contentDir: '/tmp/open-knowledge',
  pathSeparator: '/',
};
vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => workspaceStub,
}));

const toastInfoMock = vi.fn((_msg: string, _options?: { id?: string }) => {});
const toastErrorMock = vi.fn((_msg: string, _options?: { description?: string }) => {});
vi.doMock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    info: toastInfoMock,
    success: vi.fn(() => {}),
  },
}));

const { FileSidebar } = await import('./FileSidebar');

function renderSidebar() {
  return render(<FileSidebar />, { wrapper: TooltipProvider });
}

describe('FileSidebar menu-action runtime routing', () => {
  beforeEach(() => {
    activeTarget = ACTIVE_TARGET;
    mergedConfig = DEFAULT_MERGED_CONFIG;
    projectLocalSynced = true;
    if (typeof localStorage !== 'undefined') localStorage.clear();
    for (const fn of [
      toggleSidebarMock,
      toastInfoMock,
      toastErrorMock,
      projectLocalPatch,
      treeCalls.collapseAll,
      treeCalls.expandAll,
      treeCalls.startCreating,
      treeCalls.startCreatingFromTemplate,
    ]) {
      fn.mockClear();
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(() => Promise.resolve()),
      },
    });
  });

  afterEach(() => {
    cleanup();
    __resetPaneVisibilityStoreForTests();
  });

  test('a real tree-options checkbox stays in roving focus, refuses Enter, and keeps focus when ready', async () => {
    const user = userEvent.setup();
    projectLocalSynced = false;
    const rendered = renderSidebar();

    await user.click(screen.getByRole('button', { name: 'Tree view options' }));
    const menu = await screen.findByTestId('tree-options-menu');
    const pending = within(menu).getByTestId('tree-options-show-hidden-files');
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    expect(pending.getAttribute('data-disabled')).toBeNull();

    menu.focus();
    await user.keyboard('h');
    expect(document.activeElement).toBe(pending);
    expect(
      await screen.findByRole('tooltip', {
        name: 'Settings are still loading. Try again in a moment.',
      }),
    ).toBeTruthy();

    await user.keyboard('{Enter}');
    expect(projectLocalPatch).not.toHaveBeenCalled();
    expect(toastInfoMock).toHaveBeenCalledWith(
      'Settings are still loading. Try again in a moment.',
      { id: 'sidebar-settings-not-ready' },
    );
    expect(screen.getByTestId('tree-options-menu')).toBeTruthy();
    expect(document.activeElement).toBe(pending);

    await user.keyboard('{Enter}');
    expect(toastInfoMock).toHaveBeenNthCalledWith(
      2,
      'Settings are still loading. Try again in a moment.',
      { id: 'sidebar-settings-not-ready' },
    );

    projectLocalSynced = true;
    rendered.rerender(<FileSidebar />);

    const ready = within(screen.getByTestId('tree-options-menu')).getByTestId(
      'tree-options-show-hidden-files',
    );
    expect(ready).toBe(pending);
    expect(ready.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(ready);
  });

  test('a real empty-space context checkbox refuses repeated Enter with one stable notice id', async () => {
    const user = userEvent.setup();
    projectLocalSynced = false;
    renderSidebar();

    fireEvent.contextMenu(screen.getByTestId('file-tree-stub'), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole('menu');
    const pending = await screen.findByTestId('empty-space-menu-show-hidden-files');
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    expect(pending.getAttribute('data-disabled')).toBeNull();

    menu.focus();
    await user.keyboard('Show h');
    await waitFor(() => expect(document.activeElement).toBe(pending));

    await user.keyboard('{Enter}{Enter}');
    expect(projectLocalPatch).not.toHaveBeenCalled();
    expect(toastInfoMock).toHaveBeenNthCalledWith(
      1,
      'Settings are still loading. Try again in a moment.',
      { id: 'sidebar-settings-not-ready' },
    );
    expect(toastInfoMock).toHaveBeenNthCalledWith(
      2,
      'Settings are still loading. Try again in a moment.',
      { id: 'sidebar-settings-not-ready' },
    );
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(document.activeElement).toBe(pending);
  });
});
