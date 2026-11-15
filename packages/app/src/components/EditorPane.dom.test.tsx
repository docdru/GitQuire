import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isMacOS } from '@tiptap/core';
import { type ReactNode, type Ref, useEffect, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { publishSelectionContext } from '@/editor/selection-context';
import { clearPendingSourceNavigationsForTest } from '@/editor/source-editor-navigation';
import {
  type DockArrangement,
  dockArrangementStorageKey,
  legacyDockArrangement,
  readDockArrangement,
  withDockPaneAtEdge,
  writeDockArrangement,
} from '@/lib/dock-arrangement-store';
import { requestDockPaneMove } from '@/lib/dock-move-requests';
import { type DockNode, dockPaneDirection, isDockLeaf, moveDockPane } from '@/lib/dock-tree';
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
  agents: { container: HTMLElement | null; isShowing: boolean };
  editorRegion: HTMLElement | null;
};
let reportedPlacements: MockPlacements | null = null;

type MockPaneExtents = Record<PaneId, boolean>;
const PANES_WITH_EXTENT: MockPaneExtents = { editor: true, agents: true };
let paneExtents: MockPaneExtents = { ...PANES_WITH_EXTENT };

type MockEditorAreaHandle = {
  panesOnScreen(): MockPaneExtents;
};

function MockPaneExtentHandle({ handleRef }: { handleRef?: Ref<MockEditorAreaHandle> }) {
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
        data-agents-direction={dockPaneDirection(dockTree, 'agents') ?? ''}
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

  test('web host reports the editor and chat', async () => {
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: false, onScreen: false },
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
  const chatBelow = (): DockArrangement => withDockPaneAtEdge(seed(), 'agents', 'bottom');
  const drawnAgentsDirection = () =>
    screen.getByTestId('editor-area').getAttribute('data-agents-direction');
  function storedDockKeys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('ok-dock-arrangement-v1')) keys.push(key);
    }
    return keys;
  }
  const moveChatBelow = (tree: DockNode) => moveDockPane(tree, 'agents', 'editor', 'bottom');
  const shape = (node: DockNode): unknown =>
    isDockLeaf(node) ? node.pane : { [node.direction]: node.items.map((item) => shape(item.node)) };

  test('right to left, a request for the right edge docks the pane at the start', async () => {
    document.documentElement.style.direction = 'rtl';
    try {
      await renderEditorPane();
      act(() => requestDockPaneMove({ pane: 'agents', side: 'right' }));

      const drawn = drawnDockTrees.at(-1);
      if (drawn === undefined) throw new Error('the editor area never drew');
      expect(shape(drawn)).toEqual({ row: ['agents', 'editor'] });
    } finally {
      document.documentElement.style.direction = '';
    }
  });

  test('a request to move Agents to the bottom edge puts it under the editor', async () => {
    await renderEditorPane();
    act(() => requestDockPaneMove({ pane: 'agents', side: 'bottom' }));

    const drawn = drawnDockTrees.at(-1);
    if (drawn === undefined) throw new Error('the editor area never drew');
    expect(shape(drawn)).toEqual({ column: ['editor', 'agents'] });
  });

  test('repeated trips to the bottom edge and back beside the editor by header drag open the same sizes every time', async () => {
    await renderEditorPane();
    const atEdge: number[][] = [];

    for (let round = 0; round < 3; round += 1) {
      act(() => requestDockPaneMove({ pane: 'agents', side: 'bottom' }));
      const drawn = drawnDockTrees.at(-1);
      if (drawn === undefined || isDockLeaf(drawn)) throw new Error('the editor area never drew');
      expect(shape(drawn)).toEqual({ column: ['editor', 'agents'] });
      atEdge.push(drawn.items.map((item) => Number(item.size.toFixed(9))));
      act(() =>
        changeDrawnDockTree?.((tree) => moveDockPane(tree, 'agents', 'editor', 'end', 0.5)),
      );
      expect(drawnAgentsDirection()).toBe('row');
    }

    expect(atEdge[1]).toEqual(atEdge[0]);
    expect(atEdge[2]).toEqual(atEdge[0]);
  });

  test('on the web the first layout drawn is the one stored for the origin, and it holds when the project becomes known', async () => {
    delete (window as { okDesktop?: unknown }).okDesktop;
    writeDockArrangement(dockArrangementStorageKey(null), chatBelow());
    workspaceKnown = false;
    const view = await renderEditorPane();
    const { EditorPane } = await import('./EditorPane');

    const first = drawnDockTrees[0];
    if (first === undefined) throw new Error('the editor area never drew');
    expect(dockPaneDirection(first, 'agents')).toBe('column');

    workspaceKnown = true;
    act(() => view.rerender(<EditorPane />));

    expect(drawnDockTrees.length).toBeGreaterThan(1);
    expect(drawnDockTrees.map((tree) => dockPaneDirection(tree, 'agents'))).toEqual(
      drawnDockTrees.map(() => 'column'),
    );
  });

  test('on the web a layout change is saved under the origin’s name while the project is still unknown', async () => {
    delete (window as { okDesktop?: unknown }).okDesktop;
    workspaceKnown = false;
    await renderEditorPane();
    act(() => changeDrawnDockTree?.(moveChatBelow));
    await act(async () => {});

    expect(drawnAgentsDirection()).toBe('column');
    expect(storedDockKeys()).toEqual([dockArrangementStorageKey(null)]);
    const saved = readDockArrangement(dockArrangementStorageKey(null));
    expect(saved === null ? null : dockPaneDirection(saved.tree, 'agents')).toBe('column');
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

  test.each(['identity', 'auth', undefined] as const)(
    'a %s request from outside the pane is cleared without opening the auth modal, because personal git credentials are hidden',
    async (requested) => {
      const { authPromptStore } = await import('@/lib/auth-prompt-store');
      await renderEditorPane();

      await act(async () => {
        authPromptStore.request(requested);
      });

      expect(screen.getByTestId('auth-modal').getAttribute('data-open')).toBe('false');
      expect(authPromptStore.getSnapshot()).toBeNull();
    },
  );
});

describe('EditorPane keeps the Agents pane and view-in-source wiring', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as { okDesktop?: unknown }).okDesktop;
    activeProvider = undefined;
    paneExtents = { ...PANES_WITH_EXTENT };
    __resetPaneVisibilityStoreForTests();
    clearPendingSourceNavigationsForTest();
  });

  const agentsShown = () => screen.getByTestId('editor-area').getAttribute('data-agents-visible');

  test('web host: a Cmd/Ctrl+L keydown is intercepted (the agents toggle is wired)', async () => {
    await renderEditorPane();

    const init: KeyboardEventInit = { key: 'l', cancelable: true, bubbles: true };
    if (isMacOS()) init.metaKey = true;
    else init.ctrlKey = true;
    const event = new KeyboardEvent('keydown', init);
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(agentsShown()).toBe('true');
  });

  test('web host: an unrelated keydown is not intercepted', async () => {
    await renderEditorPane();

    const event = new KeyboardEvent('keydown', {
      key: 'g',
      metaKey: true,
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  test('a header request shows and hides chat', async () => {
    await renderEditorPane();

    act(() => paneVisibilityStore.request('agents', true));
    expect(agentsShown()).toBe('true');
    expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(true);

    act(() => paneVisibilityStore.request('agents', true));
    expect(agentsShown()).toBe('true');

    act(() => paneVisibilityStore.request('agents', false));
    expect(agentsShown()).toBe('false');
    expect(paneVisibilityStore.getSnapshot().agents).toEqual({ open: false, onScreen: false });
  });
});
