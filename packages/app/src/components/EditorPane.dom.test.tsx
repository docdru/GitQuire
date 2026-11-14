import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, type Ref, useEffect, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { publishSelectionContext } from '@/editor/selection-context';
import { clearPendingSourceNavigationsForTest } from '@/editor/source-editor-navigation';
import {
  type DockArrangement,
  dockArrangementStorageKey,
  dockTerminalPlacement,
  legacyDockArrangement,
  readDockArrangement,
  withDockTerminalPlacement,
  writeDockArrangement,
} from '@/lib/dock-arrangement-store';
import { requestDockPaneMove } from '@/lib/dock-move-requests';
import {
  bottomTerminalDockTree,
  DEFAULT_CHAT_SHARE,
  type DockNode,
  isDockLeaf,
  moveDockPane,
} from '@/lib/dock-tree';
import { narrowWorkspaceSessionKey } from '@/lib/narrow-workspace-session';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneId,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import { RESTORE_SETTLE_TIMEOUT_MS } from '@/lib/restore-settle-timeout';
import { revealEditor } from '@/lib/reveal-editor';

const TEST_DOC = 'docs/notes';

function clearSelection(): void {
  publishSelectionContext(TEST_DOC, 'wysiwyg', null);
  publishSelectionContext(TEST_DOC, 'source', null);
}

import * as actualLinguiMacro from '@lingui/react/macro';
import type { WorkspaceHeaderChrome } from './EditorArea';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

let hasRemote = false;
let projectLocalSynced = false;
let projectSynced = false;
let projectLocalConfig: { autoSync?: { enabled?: boolean | null } } | null = null;
let projectConfig: { autoSync?: { default?: boolean | null } } | null = null;
let pushPermissionCheckStatus: 'allowed' | 'denied' | 'unknown' | undefined = 'allowed';

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () => ({
    hasRemote,
    pushPermission: { checkStatus: pushPermissionCheckStatus },
  }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectConfig,
    projectLocalConfig,
    projectLocalSynced,
    projectSynced,
  }),
}));

let workspaceContentDir: string | null = '/tmp/project';
let workspaceKnown = true;
vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () =>
    workspaceKnown ? { contentDir: workspaceContentDir, pathSeparator: '/' } : null,
}));

let activeProvider: { document: Y.Doc } | undefined;
const activeDocumentName: string | null = TEST_DOC;
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: activeDocumentName,
    collabUrl: 'ws://test',
    activeProvider,
  }),
  isBlobRunnerNewTabId: () => false,
}));

const promotePreviewTabMock = vi.fn(() => {});
vi.doMock('@/editor/preview-tab-promotion', () => ({
  requestPreviewTabPromotion: promotePreviewTabMock,
}));

vi.doMock('@/editor/use-editor-mode', () => ({
  useEditorMode: () => ['wysiwyg', () => {}],
}));

vi.doMock('./EditorHeader', () => ({
  EditorHeader: ({ children }: { children?: ReactNode }) => (
    <div data-testid="editor-header">{children}</div>
  ),
}));

type MockPlacements = {
  terminal: { container: HTMLElement | null; isShowing: boolean };
  agents: { container: HTMLElement | null; isShowing: boolean };
  editorRegion: HTMLElement | null;
};
let reportedPlacements: MockPlacements | null = null;

type MockPaneExtents = Record<PaneId, boolean>;
const PANES_WITH_EXTENT: MockPaneExtents = { editor: true, agents: true, terminal: true };
let paneExtents: MockPaneExtents = { ...PANES_WITH_EXTENT };
let reportPaneExtentChange: (() => void) | undefined;

type MockEditorAreaHandle = {
  panesOnScreen(): MockPaneExtents;
};

function MockPaneExtentHandle({
  handleRef,
  onPaneExtentChange,
}: {
  handleRef?: Ref<MockEditorAreaHandle>;
  onPaneExtentChange?: () => void;
}) {
  reportPaneExtentChange = onPaneExtentChange;
  useImperativeHandle(handleRef, () => ({
    panesOnScreen: () => ({ ...paneExtents }),
  }));
  return null;
}

function ReportPlacements({
  onSessionPlacements,
}: {
  onSessionPlacements?: (placements: MockPlacements) => void;
}) {
  useEffect(() => {
    if (reportedPlacements !== null) onSessionPlacements?.(reportedPlacements);
  }, [onSessionPlacements]);
  return null;
}

let drawnDockTrees: DockNode[] = [];
let changeDrawnDockTree: ((update: (tree: DockNode) => DockNode) => void) | undefined;

vi.doMock('./EditorArea', () => ({
  EditorArea: ({
    ref,
    onPaneExtentChange,
    renderWorkspaceHeader,
    dockTree,
    onDockTreeChange,
    editorVisible,
    agentsVisible,
    onSessionPlacements,
  }: {
    ref?: Ref<MockEditorAreaHandle>;
    editorVisible?: boolean;
    agentsVisible?: boolean;
    onPaneExtentChange?: () => void;
    renderWorkspaceHeader?: (tabs: ReactNode, chrome: WorkspaceHeaderChrome) => ReactNode;
    dockTree: DockNode;
    onDockTreeChange: (update: (tree: DockNode) => DockNode) => void;
    onSessionPlacements?: (placements: MockPlacements) => void;
  }) => {
    drawnDockTrees.push(dockTree);
    changeDrawnDockTree = onDockTreeChange;
    return (
      <div
        data-testid="editor-area"
        data-terminal-placement={dockTerminalPlacement(dockTree)}
        data-editor-visible={String(editorVisible)}
        data-agents-visible={String(agentsVisible)}
      >
        {renderWorkspaceHeader?.(<div data-testid="workspace-tabs" />, {
          leading: null,
          trailing: null,
          sidebarSwap: false,
        })}
        <ReportPlacements onSessionPlacements={onSessionPlacements} />
        <MockPaneExtentHandle handleRef={ref} onPaneExtentChange={onPaneExtentChange} />
      </div>
    );
  },
}));

vi.doMock('@/lib/gitquire/features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitquire/features')>();
  const features = { ...actual.STANDALONE_FEATURES, aiChat: true };
  return { ...actual, useGitQuireFeatures: () => features };
});
vi.doMock('@/gitquire-chat/ChatPaneHost', () => ({
  ChatPaneHost: () => null,
}));
vi.doMock('./AuthModal', () => ({
  AuthModal: ({ open, identityPrompt }: { open: boolean; identityPrompt?: boolean }) => (
    <div
      data-testid="auth-modal"
      data-open={String(open)}
      data-identity-prompt={String(identityPrompt === true)}
    />
  ),
}));

vi.doMock('@/editor/components/TagDialog', () => ({
  TagDialog: () => <div data-testid="tag-dialog" />,
}));

vi.doMock('./AutoSyncOnboardingDialog', () => ({
  AutoSyncOnboardingDialog: ({
    open,
    variant,
    onResolved,
  }: {
    open: boolean;
    variant: string;
    onResolved: () => void;
  }) => (
    <button
      type="button"
      data-testid="auto-sync-onboarding"
      data-open={String(open)}
      data-variant={variant}
      onClick={onResolved}
    >
      Auto sync onboarding
    </button>
  ),
}));

async function renderEditorPane() {
  const { EditorPane } = await import('./EditorPane');
  const view = render(<EditorPane />);
  await act(async () => {});
  return view;
}

describe('EditorPane auto-sync onboarding gate', () => {
  afterEach(() => {
    cleanup();
    hasRemote = false;
    projectLocalSynced = false;
    projectSynced = false;
    projectLocalConfig = null;
    projectConfig = null;
    pushPermissionCheckStatus = 'allowed';
  });

  test('exports the EditorPane component', async () => {
    const mod = await import('./EditorPane');
    expect(typeof mod.EditorPane).toBe('function');
  });

  test('opens when remote exists, both configs synced, enabled is null, and no committed default', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('true');
  });

  test('opens when autoSync carries neither a mode nor a legacy enabled value', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: {} };
    projectConfig = { autoSync: { default: null } };

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('true');
  });

  test.each([
    [
      'no remote',
      false,
      true,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: null } },
    ],
    [
      'committed config not synced',
      true,
      false,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: null } },
    ],
    [
      'project-local config not synced',
      true,
      true,
      false,
      { autoSync: { enabled: null } },
      { autoSync: { default: null } },
    ],
    ['project-local config missing', true, true, true, null, { autoSync: { default: null } }],
    [
      'enabled true already answered',
      true,
      true,
      true,
      { autoSync: { enabled: true } },
      { autoSync: { default: null } },
    ],
    [
      'enabled false already answered',
      true,
      true,
      true,
      { autoSync: { enabled: false } },
      { autoSync: { default: null } },
    ],
    [
      'committed default off suppresses the prompt',
      true,
      true,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: false } },
    ],
    [
      'committed default on suppresses the prompt',
      true,
      true,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: true } },
    ],
  ] as const)(
    'stays closed when %s',
    async (_label, nextHasRemote, nextProjectSynced, nextSynced, nextProjectLocalConfig, nextProjectConfig) => {
      hasRemote = nextHasRemote;
      projectSynced = nextProjectSynced;
      projectLocalSynced = nextSynced;
      projectLocalConfig = nextProjectLocalConfig;
      projectConfig = nextProjectConfig;

      await renderEditorPane();

      expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
    },
  );

  test('a denied push probe opens the pull-only variant', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };
    pushPermissionCheckStatus = 'denied';

    await renderEditorPane();

    const dialog = screen.getByTestId('auto-sync-onboarding');
    expect(dialog.getAttribute('data-open')).toBe('true');
    expect(dialog.getAttribute('data-variant')).toBe('follow');
  });

  test('an unknown push probe keeps the prompt closed', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };
    pushPermissionCheckStatus = 'unknown';

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
  });

  test('resolved onboarding dismisses the dialog in the same render path', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };
    await renderEditorPane();

    const dialog = screen.getByTestId('auto-sync-onboarding');
    expect(dialog.getAttribute('data-open')).toBe('true');

    await userEvent.click(dialog);

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
  });
});

type DockStateResult = {
  terminalVisible: boolean;
  agentPanelVisible: boolean;
  editorVisible?: boolean;
  placement?: 'bottom' | 'right';
  rightWidth?: number;
};
function makeOkDesktopStub(
  getDockState: () => Promise<DockStateResult> = async () => ({
    terminalVisible: false,
    agentPanelVisible: false,
  }),
  ptyAvailable = true,
) {
  const menuHandlers: Array<(action: string) => void> = [];
  const viewMenuPushes: Array<{
    editorVisible?: boolean;
    terminalVisible?: boolean;
    agentPanelVisible?: boolean;
    canViewInSource?: boolean;
  }> = [];
  const dockStateUpdates: unknown[] = [];
  return {
    viewMenuPushes,
    dockStateUpdates,
    dispatchMenuAction(action: string) {
      for (const cb of menuHandlers) cb(action);
    },
    stub: {
      config: { ptyAvailable },
      onMenuAction(cb: (action: string) => void) {
        menuHandlers.push(cb);
        return () => {
          const index = menuHandlers.indexOf(cb);
          if (index >= 0) menuHandlers.splice(index, 1);
        };
      },
      editor: {
        notifyViewMenuStateChanged(state: {
          editorVisible?: boolean;
          terminalVisible?: boolean;
          agentPanelVisible?: boolean;
          canViewInSource?: boolean;
        }) {
          viewMenuPushes.push(state);
        },
      },
      terminal: {
        getDockState,
        setDockState(state: unknown) {
          dockStateUpdates.push(state);
        },
        cliInstalledMap: async () => ({
          claude: true,
          codex: false,
          opencode: false,
          cursor: false,
        }),
      },
    },
  };
}

describe('EditorPane pane visibility for the header', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as { okDesktop?: unknown }).okDesktop;
    reportedPlacements = null;
    paneExtents = { ...PANES_WITH_EXTENT };
    clearSelection();
    __resetPaneVisibilityStoreForTests();
  });

  test('web host reports chat and no terminal', async () => {
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: false, onScreen: false },
      terminal: null,
    });
  });

  test('desktop host with a working shell reports both panes', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: false, onScreen: false },
      terminal: { open: false, onScreen: false },
    });
  });

  test('desktop host without a working shell reports no terminal', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub(undefined, false).stub;
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot().terminal).toBeNull();
    expect(paneVisibilityStore.getSnapshot().agents).toEqual({ open: false, onScreen: false });
  });

  test('a note window reports neither pane', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...desk.stub,
      config: { ...desk.stub.config, mode: 'note' },
    };
    await renderEditorPane();

    expect(screen.getByTestId('editor-area')).toBeTruthy();
    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: null,
      agents: null,
      terminal: null,
    });
  });

  test('the snapshot follows the other show and hide paths', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    const seen: string[] = [];
    const stop = paneVisibilityStore.subscribe(() => {
      const { agents, terminal } = paneVisibilityStore.getSnapshot();
      seen.push(`agents=${agents?.open} terminal=${terminal?.open}`);
    });

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    stop();

    expect(seen).toEqual([
      'agents=true terminal=false',
      'agents=true terminal=true',
      'agents=false terminal=true',
    ]);
    expect(paneVisibilityStore.getSnapshot().terminal).toEqual({ open: true, onScreen: true });
  });

  test('a pending extent report reads visibility after the parent rerenders', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    const pendingReport = reportPaneExtentChange;
    expect(pendingReport).toBeDefined();

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    expect(paneVisibilityStore.getSnapshot().agents).toEqual({ open: true, onScreen: true });

    paneExtents = { ...paneExtents, agents: false };
    act(() => pendingReport?.());
    expect(paneVisibilityStore.getSnapshot().agents).toEqual({ open: true, onScreen: false });
  });

  test('a hidden pane reads off even while the layout still gives it size', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: false, onScreen: false },
      terminal: { open: false, onScreen: false },
    });
  });

  test('a note window ignores header requests', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...desk.stub,
      config: { ...desk.stub.config, mode: 'note' },
    };
    await renderEditorPane();
    expect(desk.viewMenuPushes).toContainEqual({
      agentPanelVisible: false,
      wideIntent: { agentPanelVisible: false },
    });

    act(() => paneVisibilityStore.request('agents', true));
    act(() => paneVisibilityStore.request('terminal', true));

    expect(desk.viewMenuPushes).not.toContainEqual({
      agentPanelVisible: true,
      wideIntent: { agentPanelVisible: true },
    });
    expect(desk.viewMenuPushes).not.toContainEqual({
      terminalVisible: true,
      wideIntent: { terminalVisible: true },
    });
  });

  test('a project window shows the editor by default and applies header hide and show requests', async () => {
    await renderEditorPane();
    const editorArea = screen.getByTestId('editor-area');
    expect(editorArea.getAttribute('data-editor-visible')).toBe('true');
    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: true, onScreen: true });

    act(() => paneVisibilityStore.request('editor', false));
    expect(editorArea.getAttribute('data-editor-visible')).toBe('false');
    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: false, onScreen: false });

    act(() => paneVisibilityStore.request('editor', true));
    expect(editorArea.getAttribute('data-editor-visible')).toBe('true');
    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: true, onScreen: true });
  });

  test('a single-file window keeps its Editor return destination and restricts Hide', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...desk.stub,
      config: { ...desk.stub.config, singleFile: true },
    };
    const { EditorPane } = await import('./EditorPane');
    const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
    render(
      <SingleFileModeProvider>
        <EditorPane />
      </SingleFileModeProvider>,
    );
    await act(async () => {});

    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: true, onScreen: true });
    act(() => paneVisibilityStore.request('editor', false));
    expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('true');
  });

  test('a narrow single-file window rejects an empty restored selection', async () => {
    const originalMatchMedia = window.matchMedia;
    const narrowQuery = originalMatchMedia('(width < 48rem)');
    Object.defineProperty(narrowQuery, 'matches', { configurable: true, value: true });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        query === '(width < 48rem)' ? narrowQuery : originalMatchMedia(query),
    });
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...desk.stub,
      config: { ...desk.stub.config, singleFile: true },
    };
    const key = narrowWorkspaceSessionKey('/tmp/project', 'desktop');
    sessionStorage.setItem(key, JSON.stringify({ version: 1, selected: null }));

    try {
      const { EditorPane } = await import('./EditorPane');
      const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
      render(
        <SingleFileModeProvider>
          <EditorPane />
        </SingleFileModeProvider>,
      );
      await act(async () => {});

      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('true');
    } finally {
      sessionStorage.removeItem(key);
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  test('delayed browser single-file configuration replaces an empty restored selection', async () => {
    const originalMatchMedia = window.matchMedia;
    const originalFetch = globalThis.fetch;
    const narrowQuery = originalMatchMedia('(width < 48rem)');
    Object.defineProperty(narrowQuery, 'matches', { configurable: true, value: true });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        query === '(width < 48rem)' ? narrowQuery : originalMatchMedia(query),
    });
    let resolveConfig: (response: Response) => void = () => {};
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) !== '/api/config') {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      const { promise, resolve } = Promise.withResolvers<Response>();
      resolveConfig = resolve;
      return promise;
    });
    const key = narrowWorkspaceSessionKey('/tmp/project', 'web');
    sessionStorage.setItem(key, JSON.stringify({ version: 1, selected: null }));

    try {
      const { EditorPane } = await import('./EditorPane');
      const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
      render(
        <SingleFileModeProvider>
          <EditorPane />
        </SingleFileModeProvider>,
      );
      await act(async () => {});
      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('false');

      await act(async () => {
        resolveConfig(new Response(JSON.stringify({ singleFile: true }), { status: 200 }));
      });
      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('true');
    } finally {
      sessionStorage.removeItem(key);
      globalThis.fetch = originalFetch;
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});

describe('EditorPane saves and restores whether the editor is shown', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as { okDesktop?: unknown }).okDesktop;
    __resetPaneVisibilityStoreForTests();
  });

  const editorVisibleAttr = () =>
    screen.getByTestId('editor-area').getAttribute('data-editor-visible');

  test('desktop: a saved hidden editor comes back hidden, published only once the restore settles', async () => {
    const desk = makeOkDesktopStub(async () => ({
      terminalVisible: false,
      agentPanelVisible: false,
      editorVisible: false,
    }));
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(editorVisibleAttr()).toBe('false');
    expect(desk.viewMenuPushes).toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: true,
      wideIntent: { editorVisible: true },
    });
  });

  test('desktop: a saved hidden editor that lands after the settle bound still comes back hidden', async () => {
    let release: (value: DockStateResult) => void = () => {};
    const desk = makeOkDesktopStub(() => {
      const { promise, resolve } = Promise.withResolvers<DockStateResult>();
      release = resolve;
      return promise;
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await renderEditorPane();
      await act(async () => {
        vi.advanceTimersByTime(RESTORE_SETTLE_TIMEOUT_MS + 1);
      });
      expect(editorVisibleAttr()).toBe('true');

      await act(async () => {
        release({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });
      });
    } finally {
      vi.useRealTimers();
    }

    expect(editorVisibleAttr()).toBe('false');
    expect(desk.viewMenuPushes).toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: true,
      wideIntent: { editorVisible: true },
    });
  });

  async function renderPastTheSettleBound() {
    let release: (value: DockStateResult) => void = () => {};
    const desk = makeOkDesktopStub(() => {
      const { promise, resolve } = Promise.withResolvers<DockStateResult>();
      release = resolve;
      return promise;
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await renderEditorPane();
      await act(async () => {
        vi.advanceTimersByTime(RESTORE_SETTLE_TIMEOUT_MS + 1);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(editorVisibleAttr()).toBe('true');
    const land = (value: DockStateResult) => act(async () => release(value));
    return { desk, land };
  }

  test('desktop: a show requested after the settle bound is not undone by a late saved hidden editor', async () => {
    const { desk, land } = await renderPastTheSettleBound();
    act(() => paneVisibilityStore.request('editor', true));
    await land({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });

    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test('desktop: a hide after the settle bound is not undone by a late saved shown editor', async () => {
    const { desk, land } = await renderPastTheSettleBound();
    act(() => paneVisibilityStore.request('editor', false));
    expect(editorVisibleAttr()).toBe('false');
    await land({ terminalVisible: false, agentPanelVisible: false, editorVisible: true });

    expect(editorVisibleAttr()).toBe('false');
    const editorPushes = desk.viewMenuPushes.filter((push) => 'editorVisible' in push);
    expect(editorPushes.at(-1)).toEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test("desktop: View menu toggles after the settle bound are the user's choice, and a late saved hidden editor does not undo them", async () => {
    const { desk, land } = await renderPastTheSettleBound();
    act(() => desk.dispatchMenuAction('toggle-editor'));
    expect(editorVisibleAttr()).toBe('false');
    act(() => desk.dispatchMenuAction('toggle-editor'));
    expect(editorVisibleAttr()).toBe('true');
    await land({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });

    expect(editorVisibleAttr()).toBe('true');
    const editorPushes = desk.viewMenuPushes.filter((push) => 'editorVisible' in push);
    expect(editorPushes.at(-1)).toEqual({
      editorVisible: true,
      wideIntent: { editorVisible: true },
    });
  });

  test('desktop: a late saved layout with the editor hidden and chat open keeps the editor shown', async () => {
    const { desk, land } = await renderPastTheSettleBound();
    await land({ terminalVisible: false, agentPanelVisible: true, editorVisible: false });

    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test('desktop: a record from before the editor field opens with the editor shown', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test('desktop: the editor stays shown through the restore wait, and an open during the wait keeps it shown', async () => {
    let release: (value: DockStateResult) => void = () => {};
    const desk = makeOkDesktopStub(() => {
      const { promise, resolve } = Promise.withResolvers<DockStateResult>();
      release = resolve;
      return promise;
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    expect(editorVisibleAttr()).toBe('true');
    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: true, onScreen: true });
    expect(desk.viewMenuPushes.some((push) => 'editorVisible' in push)).toBe(false);

    act(() => paneVisibilityStore.request('editor', true));
    await act(async () => {
      release({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });
    });

    expect(editorVisibleAttr()).toBe('true');
  });

  test('desktop: an explicit hide during restore publishes before settlement', async () => {
    let release: (value: DockStateResult) => void = () => {};
    const desk = makeOkDesktopStub(() => {
      const { promise, resolve } = Promise.withResolvers<DockStateResult>();
      release = resolve;
      return promise;
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    act(() => desk.dispatchMenuAction('toggle-editor'));
    expect(editorVisibleAttr()).toBe('false');
    expect(desk.viewMenuPushes).toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });

    await act(async () => {
      release({ terminalVisible: false, agentPanelVisible: false, editorVisible: true });
    });
    expect(editorVisibleAttr()).toBe('false');
    const editorPushes = desk.viewMenuPushes.filter((push) => 'editorVisible' in push);
    expect(editorPushes.at(-1)).toEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test('desktop: a deep link that opens a document before the editor pane mounts keeps a saved-hidden editor shown', async () => {
    const desk = makeOkDesktopStub(async () => ({
      terminalVisible: false,
      agentPanelVisible: false,
      editorVisible: false,
    }));
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    revealEditor();

    await renderEditorPane();

    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test('desktop: a reveal in a single-file window leaves nothing behind for a later project window', async () => {
    const singleFile = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...singleFile.stub,
      config: { ...singleFile.stub.config, singleFile: true },
    };
    const { EditorPane } = await import('./EditorPane');
    const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
    render(
      <SingleFileModeProvider>
        <EditorPane />
      </SingleFileModeProvider>,
    );
    await act(async () => {});
    act(() => revealEditor());
    cleanup();

    const project = makeOkDesktopStub(async () => ({
      terminalVisible: false,
      agentPanelVisible: false,
      editorVisible: false,
    }));
    (window as { okDesktop?: unknown }).okDesktop = project.stub;
    await renderEditorPane();

    expect(editorVisibleAttr()).toBe('false');
  });

  test('desktop: a document opened during the restore wait keeps a saved-hidden editor shown', async () => {
    let release: (value: DockStateResult) => void = () => {};
    const desk = makeOkDesktopStub(() => {
      const { promise, resolve } = Promise.withResolvers<DockStateResult>();
      release = resolve;
      return promise;
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    act(() => revealEditor());
    await act(async () => {
      release({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });
    });

    expect(editorVisibleAttr()).toBe('true');
  });

  test('desktop: every pane saved hidden reopens to nothing shown', async () => {
    const desk = makeOkDesktopStub(async () => ({
      terminalVisible: false,
      agentPanelVisible: false,
      editorVisible: false,
    }));
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: false, onScreen: false },
      agents: { open: false, onScreen: false },
      terminal: { open: false, onScreen: false },
    });
  });

  test('desktop: the View menu toggle hides and shows the editor and publishes the level', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    act(() => desk.dispatchMenuAction('toggle-editor'));
    expect(editorVisibleAttr()).toBe('false');
    expect(desk.viewMenuPushes).toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
    const pushesWhileHidden = desk.viewMenuPushes.length;
    act(() => desk.dispatchMenuAction('toggle-editor'));
    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes.slice(pushesWhileHidden)).toContainEqual({
      editorVisible: true,
      wideIntent: { editorVisible: true },
    });
  });

  test('web: the editor level survives a reload in both directions, under its own key', async () => {
    localStorage.setItem('ok-editor-visible-v1', 'false');
    await renderEditorPane();
    expect(editorVisibleAttr()).toBe('false');

    act(() => paneVisibilityStore.request('editor', true));
    cleanup();
    await renderEditorPane();
    expect(editorVisibleAttr()).toBe('true');

    act(() => paneVisibilityStore.request('editor', false));
    cleanup();
    await renderEditorPane();
    expect(editorVisibleAttr()).toBe('false');
    expect(localStorage.getItem('ok-editor-visible-v1')).toBe('false');
  });
});

describe('EditorPane keeps each project its own dock arrangement', () => {
  beforeEach(() => {
    drawnDockTrees = [];
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
  });

  afterEach(() => {
    cleanup();
    delete (window as { okDesktop?: unknown }).okDesktop;
    localStorage.clear();
    workspaceContentDir = '/tmp/project';
    workspaceKnown = true;
    drawnDockTrees = [];
    changeDrawnDockTree = undefined;
  });

  const NO_LEGACY_KEYS = { getItem: () => null };
  const seed = (): DockArrangement =>
    legacyDockArrangement(
      { widthPx: window.innerWidth, heightPx: window.innerHeight },
      NO_LEGACY_KEYS,
    );
  const rightTerminal = (): DockArrangement => withDockTerminalPlacement(seed(), 'right');
  const drawnPlacement = () =>
    screen.getByTestId('editor-area').getAttribute('data-terminal-placement');
  function storedDockKeys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('ok-dock-arrangement-v1')) keys.push(key);
    }
    return keys;
  }
  const moveTerminalRight = (tree: DockNode) => moveDockPane(tree, 'terminal', 'editor', 'end');
  const shape = (node: DockNode): unknown =>
    isDockLeaf(node) ? node.pane : { [node.direction]: node.items.map((item) => shape(item.node)) };

  test('a request to move Agents to the left edge docks it along the start, saves that, and shows it', async () => {
    await renderEditorPane();
    expect(screen.getByTestId('editor-area').getAttribute('data-agents-visible')).toBe('false');

    act(() => requestDockPaneMove({ pane: 'agents', side: 'left' }));
    await act(async () => {});

    const drawn = drawnDockTrees.at(-1);
    if (drawn === undefined) throw new Error('the editor area never drew');
    expect(shape(drawn)).toEqual({ row: ['agents', { column: ['editor', 'terminal'] }] });
    const saved = readDockArrangement(dockArrangementStorageKey('/tmp/project'));
    expect(saved === null ? null : shape(saved.tree)).toEqual(shape(drawn));
    expect(screen.getByTestId('editor-area').getAttribute('data-agents-visible')).toBe('true');
  });

  test('right to left, a request for the right edge docks the pane at the start', async () => {
    document.documentElement.style.direction = 'rtl';
    try {
      await renderEditorPane();
      act(() => requestDockPaneMove({ pane: 'agents', side: 'right' }));

      const drawn = drawnDockTrees.at(-1);
      if (drawn === undefined) throw new Error('the editor area never drew');
      expect(shape(drawn)).toEqual({ row: ['agents', { column: ['editor', 'terminal'] }] });
    } finally {
      document.documentElement.style.direction = '';
    }
  });

  test('a request to move the Terminal to the bottom edge puts it under the editor and Agents', async () => {
    await renderEditorPane();
    act(() => requestDockPaneMove({ pane: 'terminal', side: 'bottom' }));

    const drawn = drawnDockTrees.at(-1);
    if (drawn === undefined) throw new Error('the editor area never drew');
    expect(shape(drawn)).toEqual({ column: [{ row: ['editor', 'agents'] }, 'terminal'] });
  });

  test('a request to move the Terminal to the right edge opens it at the share of the space it last split with the editor', async () => {
    writeDockArrangement(dockArrangementStorageKey('/tmp/project'), {
      tree: bottomTerminalDockTree(DEFAULT_CHAT_SHARE, 0.3),
      terminalShares: { bottom: 0.3, right: 0.45 },
    });
    await renderEditorPane();
    act(() => requestDockPaneMove({ pane: 'terminal', side: 'right' }));

    const drawn = drawnDockTrees.at(-1);
    if (drawn === undefined || isDockLeaf(drawn)) throw new Error('the editor area never drew');
    expect(shape(drawn)).toEqual({ row: ['editor', 'agents', 'terminal'] });
    const [editor, , terminal] = drawn.items.map((item) => item.size);
    if (editor === undefined || terminal === undefined) throw new Error('the row lost a pane');
    expect(terminal / (terminal + editor)).toBeCloseTo(0.45, 10);
  });

  test('a Terminal moved to an edge and back below the editor returns at the height it left with', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    writeDockArrangement(dockArrangementStorageKey('/tmp/project'), {
      tree: bottomTerminalDockTree(DEFAULT_CHAT_SHARE, 0.5),
      terminalShares: { bottom: 0.3, right: 0.45 },
    });
    await renderEditorPane();

    act(() => requestDockPaneMove({ pane: 'terminal', side: 'left' }));
    expect(drawnPlacement()).toBe('right');
    act(() => desk.dispatchMenuAction('move-terminal'));

    const drawn = drawnDockTrees.at(-1);
    if (drawn === undefined || isDockLeaf(drawn)) throw new Error('the editor area never drew');
    expect(shape(drawn)).toEqual({ row: [{ column: ['editor', 'terminal'] }, 'agents'] });
    const column = drawn.items[0]?.node;
    if (column === undefined || isDockLeaf(column)) throw new Error('the editor column is gone');
    expect(column.items[1]?.size).toBeCloseTo(0.5, 10);
  });

  test('repeated trips to the right edge and back under the editor by header drag open the same sizes every time', async () => {
    await renderEditorPane();
    const atEdge: number[][] = [];

    for (let round = 0; round < 3; round += 1) {
      act(() => requestDockPaneMove({ pane: 'terminal', side: 'right' }));
      const drawn = drawnDockTrees.at(-1);
      if (drawn === undefined || isDockLeaf(drawn)) throw new Error('the editor area never drew');
      expect(shape(drawn)).toEqual({ row: ['editor', 'agents', 'terminal'] });
      atEdge.push(drawn.items.map((item) => Number(item.size.toFixed(9))));
      act(() =>
        changeDrawnDockTree?.((tree) => moveDockPane(tree, 'terminal', 'editor', 'bottom', 0.5)),
      );
      expect(drawnPlacement()).toBe('bottom');
    }

    expect(atEdge[1]).toEqual(atEdge[0]);
    expect(atEdge[2]).toEqual(atEdge[0]);
  });

  test('the first layout drawn is the arrangement the project stored', async () => {
    writeDockArrangement(dockArrangementStorageKey('/tmp/project'), rightTerminal());
    await renderEditorPane();

    const first = drawnDockTrees[0];
    if (first === undefined) throw new Error('the editor area never drew');
    expect(dockTerminalPlacement(first)).toBe('right');
    expect(drawnPlacement()).toBe('right');
  });

  test('nothing is saved until the layout changes, and a change is saved under the project key', async () => {
    await renderEditorPane();
    expect(drawnPlacement()).toBe('bottom');
    expect(storedDockKeys()).toEqual([]);

    act(() => changeDrawnDockTree?.(moveTerminalRight));

    expect(drawnPlacement()).toBe('right');
    expect(storedDockKeys()).toEqual([dockArrangementStorageKey('/tmp/project')]);
    const saved = readDockArrangement(dockArrangementStorageKey('/tmp/project'));
    expect(saved === null ? null : dockTerminalPlacement(saved.tree)).toBe('right');
  });

  test('a project switch draws that project’s arrangement, or the same seed a reload gives it', async () => {
    writeDockArrangement(dockArrangementStorageKey('/tmp/project-b'), rightTerminal());
    workspaceContentDir = '/tmp/project-a';
    const view = await renderEditorPane();
    const { EditorPane } = await import('./EditorPane');
    expect(drawnPlacement()).toBe('bottom');

    workspaceContentDir = '/tmp/project-b';
    act(() => view.rerender(<EditorPane />));
    expect(drawnPlacement()).toBe('right');

    workspaceContentDir = '/tmp/project-c';
    act(() => view.rerender(<EditorPane />));
    expect(drawnPlacement()).toBe('bottom');
    const switched = drawnDockTrees.at(-1);

    cleanup();
    await renderEditorPane();
    expect(drawnDockTrees.at(-1)).toEqual(switched);
    expect(storedDockKeys()).toEqual([dockArrangementStorageKey('/tmp/project-b')]);
  });

  test('on the web the first layout drawn is the one stored for the origin, and it holds when the project becomes known', async () => {
    delete (window as { okDesktop?: unknown }).okDesktop;
    writeDockArrangement(dockArrangementStorageKey(null), rightTerminal());
    workspaceKnown = false;
    const view = await renderEditorPane();
    const { EditorPane } = await import('./EditorPane');

    const first = drawnDockTrees[0];
    if (first === undefined) throw new Error('the editor area never drew');
    expect(dockTerminalPlacement(first)).toBe('right');

    workspaceKnown = true;
    act(() => view.rerender(<EditorPane />));

    expect(drawnDockTrees.length).toBeGreaterThan(1);
    expect(drawnDockTrees.map(dockTerminalPlacement)).toEqual(drawnDockTrees.map(() => 'right'));
  });

  test('a layout change in one project stays with it when the window switches to a project with none saved', async () => {
    workspaceContentDir = '/tmp/project-a';
    const view = await renderEditorPane();
    const { EditorPane } = await import('./EditorPane');
    act(() => changeDrawnDockTree?.(moveTerminalRight));
    expect(drawnPlacement()).toBe('right');

    workspaceContentDir = '/tmp/project-b';
    act(() => view.rerender(<EditorPane />));

    expect(drawnPlacement()).toBe('bottom');
    expect(storedDockKeys()).toEqual([dockArrangementStorageKey('/tmp/project-a')]);
  });

  test('on the web a layout change is saved under the origin’s name while the project is still unknown', async () => {
    delete (window as { okDesktop?: unknown }).okDesktop;
    workspaceKnown = false;
    await renderEditorPane();
    act(() => changeDrawnDockTree?.(moveTerminalRight));
    await act(async () => {});

    expect(drawnPlacement()).toBe('right');
    expect(storedDockKeys()).toEqual([dockArrangementStorageKey(null)]);
    const saved = readDockArrangement(dockArrangementStorageKey(null));
    expect(saved === null ? null : dockTerminalPlacement(saved.tree)).toBe('right');
  });
});

describe('EditorPane mode switch promotes the preview tab', () => {
  afterEach(() => {
    cleanup();
    delete (window as { okDesktop?: unknown }).okDesktop;
    promotePreviewTabMock.mockClear();
    activeProvider = undefined;
    clearPendingSourceNavigationsForTest();
  });

  function pressModeToggle() {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'KeyM',
          key: 'm',
          altKey: true,
          metaKey: true,
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
  }

  test('flipping a doc between source and WYSIWYG promotes its tab', async () => {
    activeProvider = { document: new Y.Doc() };
    await renderEditorPane();

    pressModeToggle();

    expect(promotePreviewTabMock).toHaveBeenCalledWith('docs/notes');
  });

  test('a mode flip after the provider changes reads the current document', async () => {
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    const firstSource = vi.spyOn(firstDocument, 'getText');
    const secondSource = vi.spyOn(secondDocument, 'getText');
    activeProvider = { document: firstDocument };
    const view = await renderEditorPane();

    pressModeToggle();
    expect(firstSource).toHaveBeenCalledWith('source');

    activeProvider = { document: secondDocument };
    const { EditorPane } = await import('./EditorPane');
    act(() => view.rerender(<EditorPane />));
    firstSource.mockClear();
    secondSource.mockClear();
    pressModeToggle();

    expect(secondSource).toHaveBeenCalledWith('source');
    expect(firstSource).not.toHaveBeenCalled();
    expect(promotePreviewTabMock).toHaveBeenCalledTimes(2);
    expect(promotePreviewTabMock).toHaveBeenNthCalledWith(2, 'docs/notes');
  });

  test('a flip with no provider yet promotes nothing', async () => {
    activeProvider = undefined;
    await renderEditorPane();

    pressModeToggle();

    expect(promotePreviewTabMock).not.toHaveBeenCalled();
  });
});

describe('EditorPane auth prompts', () => {
  afterEach(() => {
    cleanup();
  });

  test.each([
    { requested: 'identity', identityPrompt: 'true' },
    { requested: 'auth', identityPrompt: 'false' },
  ] as const)(
    'a $requested request from outside the pane opens the auth modal at that step',
    async ({ requested, identityPrompt }) => {
      const { authPromptStore } = await import('@/lib/auth-prompt-store');
      await renderEditorPane();
      expect(screen.getByTestId('auth-modal').getAttribute('data-open')).toBe('false');

      await act(async () => {
        authPromptStore.request(requested);
      });

      const modal = screen.getByTestId('auth-modal');
      expect(modal.getAttribute('data-open')).toBe('true');
      expect(modal.getAttribute('data-identity-prompt')).toBe(identityPrompt);
      expect(authPromptStore.getSnapshot()).toBeNull();
    },
  );

  test('a request that names no step opens the sign-in step', async () => {
    const { authPromptStore } = await import('@/lib/auth-prompt-store');
    await renderEditorPane();

    await act(async () => {
      authPromptStore.request();
    });

    const modal = screen.getByTestId('auth-modal');
    expect(modal.getAttribute('data-open')).toBe('true');
    expect(modal.getAttribute('data-identity-prompt')).toBe('false');
  });
});
