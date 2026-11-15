import type { HocuspocusProvider } from '@hocuspocus/provider';
import { isEditableTextDocFile } from '@inkeep/open-knowledge-core/constants/code-languages';
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { getEditorForDoc } from '@/editor/active-editor';
import { EmojiInsertPopover } from '@/editor/components/EmojiInsertPopover';
import { TagDialog } from '@/editor/components/TagDialog';
import { useDocumentContext } from '@/editor/DocumentContext';
import { RAW_MDX_NAV_EVENT, type RawMdxNavDetail } from '@/editor/extensions/raw-mdx-nav-event';
import { captureModeSwitchAnchor, requestViewInSource } from '@/editor/mode-switch-landing';
import { requestPreviewTabPromotion } from '@/editor/preview-tab-promotion';
import { getSelectionContext, subscribeSelectionContext } from '@/editor/selection-context';
import { editingSurfaceFor } from '@/editor/selection-stats';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { type EditorModeValue, useEditorMode } from '@/editor/use-editor-mode';
import { VIEW_IN_SOURCE_EVENT, type ViewInSourceDetail } from '@/editor/view-in-source-event';
import { ChatPaneHost } from '@/gitquire-chat/ChatPaneHost';
import { useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { useNoPushPermissionToast } from '@/hooks/use-no-push-permission-toast';
import { useSyncAuthPrompt } from '@/hooks/use-sync-auth-prompt';
import { useWorktreeAutoSyncNotice } from '@/hooks/use-worktree-autosync-notice';
import type { AuthPromptStep } from '@/lib/auth-prompt-store';
import { loadBoolPref, saveBoolPref } from '@/lib/bool-pref';
import { useConfigContext } from '@/lib/config-provider';
import {
  type DockArrangement,
  dockArrangementStorageKey,
  dockTerminalPlacement,
  legacyDockArrangement,
  readDockArrangement,
  withDockPaneAtEdge,
  withDockTerminalPlacement,
  withDockTree,
  writeDockArrangement,
} from '@/lib/dock-arrangement-store';
import { type DockPaneMove, subscribeDockPaneMoves } from '@/lib/dock-move-requests';
import { readWebDockSessionOrder } from '@/lib/dock-session-persistence';
import type { DockEdge, DockNode } from '@/lib/dock-tree';
import { agentsPaneIsChat, useGitQuireFeatures } from '@/lib/gitquire/features';
import { matchesKeyboardShortcut, matchesRendererShortcut } from '@/lib/keyboard-shortcuts';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import {
  isExplicitInitialDocumentNavigation,
  narrowWorkspaceSessionKey,
  readNarrowWorkspaceSession,
  writeNarrowWorkspaceSession,
} from '@/lib/narrow-workspace-session';
import { isNoteWindow } from '@/lib/note-window-mode';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import {
  assertNeverPaneId,
  isPaneId,
  type PaneId,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import { RESTORE_SETTLE_TIMEOUT_MS } from '@/lib/restore-settle-timeout';
import { revealEditorBeforeActing } from '@/lib/reveal-editor';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { useWorkspace } from '@/lib/use-workspace';
import { setViewMenuState } from '@/lib/view-menu-state-store';
import { useSyncStatus } from '@/presence/use-sync-status';
import { AuthModal } from './AuthModal';
import { AutoSyncOnboardingDialog } from './AutoSyncOnboardingDialog';
import { resolveAutoSyncOnboarding } from './auto-sync-onboarding-gate';
import { type PanelTab, TABS } from './DocPanel';
import {
  EditorArea,
  type EditorAreaHandle,
  type SessionPlacements,
  type WorkspaceHeaderChrome,
} from './EditorArea';
import { EditorHeader } from './EditorHeader';
import { EditorModeToggle } from './EditorModeToggle';
import { EditorSidebarsContextMenu } from './EditorSidebarsContextMenu';
export type EditorMode = EditorModeValue;

type ModeChangeState = {
  docName: string | null;
  provider: HocuspocusProvider | null;
  mode: EditorModeValue;
  setMode: (mode: EditorModeValue) => void;
  setPersistedMode: (mode: EditorModeValue) => void;
};

function useModeChangeHandler(state: ModeChangeState) {
  const current = useRef(state);
  useLayoutEffect(() => {
    current.current = state;
  });
  const [handleModeChange] = useState(() => (mode: EditorModeValue) => {
    const currentState = current.current;
    if (currentState.docName && currentState.provider && currentState.mode !== mode) {
      captureModeSwitchAnchor({
        from: currentState.mode,
        to: mode,
        docName: currentState.docName,
        ytext: currentState.provider.document.getText('source'),
      });
      requestPreviewTabPromotion(currentState.docName);
    }
    currentState.setMode(mode);
    currentState.setPersistedMode(mode);
  });
  return handleModeChange;
}

type PaneSelectionState = {
  exclusive: boolean;
  readyNarrowSessionKey: string | null;
  narrowSessionKey: string | null;
  narrowSelection: PaneId | null;
  agentsVisible: boolean;
  terminalAvailable: boolean;
  terminalVisible: boolean;
  lastInteractedPaneRef: { current: PaneId | null };
  narrowRecentPanesRef: { current: PaneId[] };
  narrowHiddenPanesRef: { current: Set<PaneId> };
  narrowInteractedSinceMountRef: { current: boolean };
  setNarrowSelection: (selected: PaneId | null) => void;
};

type NarrowRecordState = Pick<
  PaneSelectionState,
  | 'exclusive'
  | 'readyNarrowSessionKey'
  | 'narrowSessionKey'
  | 'lastInteractedPaneRef'
  | 'narrowRecentPanesRef'
  | 'narrowHiddenPanesRef'
>;

function persistNarrowSessionForState(state: NarrowRecordState, selected: PaneId | null) {
  if (
    !state.exclusive ||
    state.readyNarrowSessionKey !== state.narrowSessionKey ||
    state.narrowSessionKey === null
  )
    return;
  writeNarrowWorkspaceSession(state.narrowSessionKey, {
    selected,
    lastInteracted: state.lastInteractedPaneRef.current,
    recent: state.narrowRecentPanesRef.current,
    hidden: [...state.narrowHiddenPanesRef.current],
  });
}

function selectPaneForState(state: PaneSelectionState, pane: PaneId) {
  state.narrowInteractedSinceMountRef.current = true;
  state.lastInteractedPaneRef.current = pane;
  state.narrowHiddenPanesRef.current.delete(pane);
  state.narrowRecentPanesRef.current = [
    pane,
    ...state.narrowRecentPanesRef.current.filter((recent) => recent !== pane),
  ];
  if (state.exclusive) {
    state.setNarrowSelection(pane);
    persistNarrowSessionForState(state, pane);
  }
}

function hidePaneForState(state: PaneSelectionState, pane: PaneId) {
  state.narrowInteractedSinceMountRef.current = true;
  state.narrowHiddenPanesRef.current.add(pane);
  if (!state.exclusive) return;
  if (state.narrowSelection !== pane) {
    persistNarrowSessionForState(state, state.narrowSelection);
    return;
  }
  if (pane !== 'editor') {
    selectPaneForState(state, 'editor');
    return;
  }
  const eligible = (candidate: PaneId) =>
    candidate !== 'editor' &&
    !state.narrowHiddenPanesRef.current.has(candidate) &&
    (candidate === 'agents'
      ? state.agentsVisible || state.narrowRecentPanesRef.current.includes('agents')
      : state.terminalAvailable &&
        (state.terminalVisible || state.narrowRecentPanesRef.current.includes('terminal')));
  const fallbackOrder: readonly PaneId[] = [
    ...state.narrowRecentPanesRef.current,
    'agents',
    'terminal',
  ];
  const next = fallbackOrder.find(eligible);
  if (next === undefined) {
    state.setNarrowSelection(null);
    persistNarrowSessionForState(state, null);
    return;
  }
  selectPaneForState(state, next);
}

type PaneVisibilityState = {
  selection: PaneSelectionState;
  setAgentsVisible: (visible: boolean) => void;
  setTerminalVisible: (visible: boolean) => void;
};

function usePaneVisibilityHandlers(state: PaneVisibilityState) {
  const current = useRef(state);
  useLayoutEffect(() => {
    current.current = state;
  });
  const [selectPane] = useState(() => (pane: PaneId) => {
    selectPaneForState(current.current.selection, pane);
  });
  const [hidePane] = useState(() => (pane: PaneId) => {
    hidePaneForState(current.current.selection, pane);
  });
  const [applyPaneRequest] = useState(() => (pane: PaneId, open: boolean) => {
    const currentState = current.current;
    if (open) {
      selectPaneForState(currentState.selection, pane);
      return;
    }
    hidePaneForState(currentState.selection, pane);
  });
  const [handleAgentsVisibleChange] = useState(
    () => (visible: boolean, reason?: 'session-close') => {
      const currentState = current.current;
      const selection = currentState.selection;
      if (!selection.exclusive) {
        if (visible) selectPaneForState(selection, 'agents');
        else hidePaneForState(selection, 'agents');
        currentState.setAgentsVisible(visible);
        return;
      }
      if (reason === 'session-close') currentState.setAgentsVisible(false);
      if (visible) selectPaneForState(selection, 'agents');
      else hidePaneForState(selection, 'agents');
    },
  );
  const [handleTerminalVisibleChange] = useState(
    () => (visible: boolean, reason?: 'session-close') => {
      const currentState = current.current;
      const selection = currentState.selection;
      if (!selection.exclusive) {
        if (visible && selection.terminalAvailable) selectPaneForState(selection, 'terminal');
        else if (!visible) hidePaneForState(selection, 'terminal');
        currentState.setTerminalVisible(visible);
        return;
      }
      if (reason === 'session-close') currentState.setTerminalVisible(false);
      if (visible && selection.terminalAvailable) selectPaneForState(selection, 'terminal');
      else if (!visible) hidePaneForState(selection, 'terminal');
    },
  );
  return {
    selectPane,
    hidePane,
    applyPaneRequest,
    handleAgentsVisibleChange,
    handleTerminalVisibleChange,
  };
}

type PaneExtentPublisherState = {
  editorAreaRef: { current: EditorAreaHandle | null };
  editorVisible: boolean;
  agentsVisible: boolean;
  agentsAvailable: boolean;
  terminalVisible: boolean;
  terminalAvailable: boolean;
  noteWindow: boolean;
  exclusive: boolean;
};

function usePaneExtentPublisher(state: PaneExtentPublisherState) {
  const current = useRef(state);
  useLayoutEffect(() => {
    current.current = state;
  });
  const [publish] = useState(() => () => {
    const latest = current.current;
    const onScreen = latest.editorAreaRef.current?.panesOnScreen() ?? {
      editor: latest.editorVisible,
      agents: false,
      terminal: false,
    };
    paneVisibilityStore.publish(
      {
        editor: latest.noteWindow
          ? null
          : { open: latest.editorVisible, onScreen: latest.editorVisible },
        agents: latest.agentsAvailable
          ? { open: latest.agentsVisible, onScreen: latest.agentsVisible && onScreen.agents }
          : null,
        terminal: latest.terminalAvailable
          ? {
              open: latest.terminalVisible,
              onScreen: latest.terminalVisible && onScreen.terminal,
            }
          : null,
      },
      latest.exclusive,
    );
  });
  return publish;
}

function NoteWindowModeToggle({
  provider,
  editorMode,
  onModeChange,
}: {
  provider: HocuspocusProvider | null;
  editorMode: EditorModeValue;
  onModeChange: (mode: EditorModeValue) => void;
}) {
  const syncStatus = useSyncStatus(provider);
  return (
    <EditorModeToggle
      isSourceMode={editorMode === 'source'}
      onModeChange={onModeChange}
      sourceDisabled={syncStatus !== 'connected' && syncStatus !== 'synced'}
    />
  );
}

type WorkspaceHeaderState = {
  noteWindow: boolean;
  activeDocName: string | null;
  activeProvider: HocuspocusProvider | null;
  editorMode: EditorModeValue;
  onModeChange: (mode: EditorModeValue) => void;
};

function WorkspaceHeader({
  tabs,
  leading,
  trailing,
  sidebarSwap,
  state,
}: {
  tabs: ReactNode;
  leading: ReactNode;
  trailing: ReactNode;
  sidebarSwap: boolean;
  state: WorkspaceHeaderState;
}) {
  const header = (
    <EditorHeader
      leading={leading}
      trailing={trailing}
      noteModeToggle={
        state.noteWindow &&
        state.activeDocName !== null &&
        !isEditableTextDocFile(state.activeDocName) ? (
          <NoteWindowModeToggle
            provider={state.activeProvider}
            editorMode={state.editorMode}
            onModeChange={state.onModeChange}
          />
        ) : null
      }
    >
      {tabs}
    </EditorHeader>
  );
  return sidebarSwap ? <EditorSidebarsContextMenu>{header}</EditorSidebarsContextMenu> : header;
}

function createWorkspaceHeaderRenderer(state: WorkspaceHeaderState) {
  return (tabs: ReactNode, chrome: WorkspaceHeaderChrome) => (
    <WorkspaceHeader
      tabs={tabs}
      leading={chrome.leading}
      trailing={chrome.trailing}
      sidebarSwap={chrome.sidebarSwap}
      state={state}
    />
  );
}

interface RestoreVisibilityGate {
  pendingWithhold: boolean;
  levelEstablished: boolean;
  lastLevel: boolean;
}

const RESTORE_UNESTABLISHED_LEVEL = false;
const WEB_EDITOR_VISIBLE_KEY = 'ok-editor-visible-v1';
const NARROW_WORKSPACE_QUERY = '(width < 48rem)';

function subscribeNarrowWorkspace(listener: () => void): () => void {
  const query = window.matchMedia(NARROW_WORKSPACE_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function narrowWorkspaceSnapshot(): boolean {
  return window.matchMedia(NARROW_WORKSPACE_QUERY).matches;
}

interface ProjectDock {
  readonly key: string;
  readonly arrangement: DockArrangement;
  readonly edited: boolean;
}

function loadDockArrangement(key: string): DockArrangement {
  return (
    readDockArrangement(key) ??
    legacyDockArrangement({ widthPx: window.innerWidth, heightPx: window.innerHeight })
  );
}

function makeRestoreVisibilityGate(mountLevel: boolean): RestoreVisibilityGate {
  return { pendingWithhold: false, levelEstablished: false, lastLevel: mountLevel };
}

function armRestoreVisibilityGate(gate: { current: RestoreVisibilityGate }): void {
  gate.current.pendingWithhold = true;
}

function resetRestoreVisibilityGate(gate: { current: RestoreVisibilityGate }): void {
  gate.current.pendingWithhold = false;
  gate.current.levelEstablished = false;
}

function noteRestoreVisibilityLevel(
  gate: { current: RestoreVisibilityGate },
  visible: boolean,
): void {
  if (gate.current.lastLevel === visible) return;
  gate.current.lastLevel = visible;
  gate.current.levelEstablished = true;
}

function consumeRestoreVisibilityGate(gate: { current: RestoreVisibilityGate }): boolean {
  if (!gate.current.pendingWithhold) return true;
  gate.current.pendingWithhold = false;
  return gate.current.levelEstablished;
}

export function EditorPane() {
  const [persistedMode, setPersistedMode] = useEditorMode();
  const [editorMode, setEditorMode] = useState<EditorMode>(persistedMode);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authInitialStep, setAuthInitialStep] = useState<AuthPromptStep>('auth');
  const syncStatus = useGitSyncStatus();
  useSyncAuthPrompt(syncStatus?.remote, (step) => {
    setAuthInitialStep(step);
    setAuthModalOpen(true);
  });
  const [activeTab, setActiveTab] = useState<PanelTab>(TABS[0].id);
  const [autoSyncOnboardingDismissed, setAutoSyncOnboardingDismissed] = useState(false);
  const desktopBridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const noteWindow = isNoteWindow();
  const gitquireFeatures = useGitQuireFeatures();
  const chatPane = !noteWindow && agentsPaneIsChat(gitquireFeatures);
  const agentsAvailable = chatPane;
  const singleFile = useSingleFileMode();
  const workspace = useWorkspace();
  const belowMainBreakpoint = useSyncExternalStore(
    subscribeNarrowWorkspace,
    narrowWorkspaceSnapshot,
    () => false,
  );
  const exclusive = belowMainBreakpoint && !noteWindow;
  const [narrowSelection, setNarrowSelection] = useState<PaneId | null>('editor');
  const [readyNarrowSessionKey, setReadyNarrowSessionKey] = useState<string | null>(null);
  const lastInteractedPaneRef = useRef<PaneId | null>(null);
  const narrowRecentPanesRef = useRef<PaneId[]>([]);
  const narrowHiddenPanesRef = useRef<Set<PaneId>>(new Set());
  const narrowInteractedSinceMountRef = useRef(false);
  const loadedNarrowSessionKeyRef = useRef<string | null>(null);
  const initialExclusiveRef = useRef(exclusive);
  const layoutRestoreFocusHoldRef = useRef(false);
  const wasExclusiveRef = useRef(exclusive);
  const editorToggleable = !noteWindow && !singleFile;
  const [editorShown, setEditorShown] = useState(() =>
    desktopBridge == null ? loadBoolPref(WEB_EDITOR_VISIBLE_KEY, true) : true,
  );
  const editorChosenSinceMountRef = useRef(false);
  const editorVisible = !editorToggleable || editorShown;
  const terminalAvailable =
    !noteWindow &&
    desktopBridge != null &&
    desktopBridge.terminal != null &&
    desktopBridge.config.ptyAvailable === true;
  const narrowSessionKey =
    workspace === null
      ? null
      : narrowWorkspaceSessionKey(workspace.contentDir, desktopBridge === null ? 'web' : 'desktop');
  useEffect(() => {
    if (narrowSessionKey === null || loadedNarrowSessionKeyRef.current === narrowSessionKey) return;
    loadedNarrowSessionKeyRef.current = narrowSessionKey;
    if (initialExclusiveRef.current && !narrowInteractedSinceMountRef.current) {
      if (isExplicitInitialDocumentNavigation()) {
        lastInteractedPaneRef.current = 'editor';
        setNarrowSelection('editor');
      } else {
        const stored = readNarrowWorkspaceSession(narrowSessionKey, terminalAvailable);
        if (stored !== undefined) {
          lastInteractedPaneRef.current = stored.lastInteracted;
          narrowRecentPanesRef.current = stored.recent;
          narrowHiddenPanesRef.current = new Set(stored.hidden);
          setNarrowSelection(singleFile && stored.selected === null ? 'editor' : stored.selected);
        }
      }
    }
    setReadyNarrowSessionKey(narrowSessionKey);
  }, [narrowSessionKey, terminalAvailable, singleFile]);
  useEffect(() => {
    persistNarrowSessionForState(
      {
        exclusive,
        readyNarrowSessionKey,
        narrowSessionKey,
        lastInteractedPaneRef,
        narrowRecentPanesRef,
        narrowHiddenPanesRef,
      },
      narrowSelection,
    );
  }, [exclusive, readyNarrowSessionKey, narrowSessionKey, narrowSelection]);
  const [terminalVisible, setTerminalVisible] = useState<boolean>(RESTORE_UNESTABLISHED_LEVEL);
  const dockArrangementKey = dockArrangementStorageKey(
    desktopBridge === null ? null : (workspace?.contentDir ?? null),
  );
  const [dock, setDock] = useState<ProjectDock>(() => ({
    key: dockArrangementKey,
    arrangement: loadDockArrangement(dockArrangementKey),
    edited: false,
  }));
  if (dock.key !== dockArrangementKey) {
    setDock({
      key: dockArrangementKey,
      arrangement: loadDockArrangement(dockArrangementKey),
      edited: false,
    });
  }
  useEffect(() => {
    if (dock.edited) writeDockArrangement(dock.key, dock.arrangement);
  }, [dock]);
  function updateDockArrangement(update: (current: DockArrangement) => DockArrangement) {
    setDock((current) => {
      const arrangement = update(current.arrangement);
      return arrangement === current.arrangement
        ? current
        : { key: current.key, arrangement, edited: true };
    });
  }
  function changeDockTree(update: (tree: DockNode) => DockNode) {
    updateDockArrangement((current) => withDockTree(current, update(current.tree)));
  }
  const dockTree = dock.arrangement.tree;
  const terminalPlacement = dockTerminalPlacement(dockTree);
  const moveTerminalEvent = useEffectEvent(() => {
    updateDockArrangement((current) =>
      withDockTerminalPlacement(
        current,
        dockTerminalPlacement(current.tree) === 'bottom' ? 'right' : 'bottom',
      ),
    );
  });
  const moveDockPaneEvent = useEffectEvent(({ pane, side }: DockPaneMove) => {
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const edge: DockEdge =
      side === 'top' || side === 'bottom' ? side : (side === 'left') !== rtl ? 'start' : 'end';
    updateDockArrangement((current) => withDockPaneAtEdge(current, pane, edge));
    paneVisibilityStore.request(pane, true);
  });
  useEffect(() => {
    if (noteWindow) return;
    return subscribeDockPaneMoves(moveDockPaneEvent);
  }, [noteWindow]);
  const [agentsVisible, setAgentsVisible] = useState<boolean>(() =>
    desktopBridge == null
      ? (readWebDockSessionOrder('agents')?.agentPanelVisible ?? false)
      : RESTORE_UNESTABLISHED_LEVEL,
  );
  useLayoutEffect(() => {
    if (exclusive && !wasExclusiveRef.current) {
      const last = lastInteractedPaneRef.current;
      const candidates: readonly PaneId[] = [
        ...(last === null ? [] : [last]),
        ...narrowRecentPanesRef.current,
        'editor',
        ...(agentsVisible ? ['agents' as const] : []),
        ...(terminalVisible ? ['terminal' as const] : []),
      ];
      const next = candidates.find(
        (pane) =>
          !narrowHiddenPanesRef.current.has(pane) && (pane !== 'terminal' || terminalAvailable),
      );
      setNarrowSelection(next ?? null);
    } else if (!exclusive && wasExclusiveRef.current) {
      layoutRestoreFocusHoldRef.current = true;
    }
    wasExclusiveRef.current = exclusive;
  }, [exclusive, terminalAvailable, agentsVisible, terminalVisible]);
  const effectiveEditorVisible = exclusive ? narrowSelection === 'editor' : editorVisible;
  const effectiveAgentsVisible = exclusive ? narrowSelection === 'agents' : agentsVisible;
  const effectiveTerminalVisible = exclusive
    ? narrowSelection === 'terminal' && terminalAvailable
    : terminalVisible;
  const [dockRestoreSettled, setDockRestoreSettled] = useState(false);
  const terminalRestoreGateRef = useRef<RestoreVisibilityGate>(
    makeRestoreVisibilityGate(terminalVisible),
  );
  const agentsRestoreGateRef = useRef<RestoreVisibilityGate>(
    makeRestoreVisibilityGate(agentsVisible),
  );
  const editorRestoreGateRef = useRef<RestoreVisibilityGate>(
    makeRestoreVisibilityGate(editorShown),
  );
  const [placements, setPlacements] = useState<SessionPlacements>({
    terminal: { container: null, isShowing: false },
    agents: { container: null, isShowing: false },
    editorRegion: null,
  });

  const editorAreaRef = useRef<EditorAreaHandle>(null);
  const paneSelectionState: PaneSelectionState = {
    exclusive,
    readyNarrowSessionKey,
    narrowSessionKey,
    narrowSelection,
    agentsVisible,
    terminalAvailable,
    terminalVisible,
    lastInteractedPaneRef,
    narrowRecentPanesRef,
    narrowHiddenPanesRef,
    narrowInteractedSinceMountRef,
    setNarrowSelection,
  };

  const {
    selectPane,
    hidePane,
    applyPaneRequest,
    handleAgentsVisibleChange,
    handleTerminalVisibleChange,
  } = usePaneVisibilityHandlers({
    selection: paneSelectionState,
    setAgentsVisible,
    setTerminalVisible,
  });

  useEffect(() => {
    if (exclusive || noteWindow) return;
    const recordInteraction = (event: Event) => {
      if (event.type === 'focusin') {
        if (layoutRestoreFocusHoldRef.current) return;
      } else {
        layoutRestoreFocusHoldRef.current = false;
      }
      if (event.type === 'keydown' && event.defaultPrevented) return;
      if (!(event.target instanceof Element)) return;
      const card = event.target.closest<HTMLElement>('[data-slot="pane-card"][data-pane]');
      const pane = card?.getAttribute('data-pane');
      if (!isPaneId(pane)) return;
      selectPane(pane);
    };
    document.addEventListener('focusin', recordInteraction, true);
    document.addEventListener('pointerdown', recordInteraction, true);
    document.addEventListener('keydown', recordInteraction, true);
    return () => {
      document.removeEventListener('focusin', recordInteraction, true);
      document.removeEventListener('pointerdown', recordInteraction, true);
      document.removeEventListener('keydown', recordInteraction, true);
    };
  }, [exclusive, noteWindow, selectPane]);

  useEffect(() => {
    if (exclusive && singleFile && narrowSelection === null) selectPane('editor');
  }, [exclusive, singleFile, narrowSelection, selectPane]);

  const publishPaneVisibility = usePaneExtentPublisher({
    editorAreaRef,
    editorVisible: effectiveEditorVisible,
    agentsVisible: effectiveAgentsVisible,
    agentsAvailable,
    terminalVisible: effectiveTerminalVisible,
    terminalAvailable,
    noteWindow,
    exclusive,
  });

  useLayoutEffect(publishPaneVisibility);

  useLayoutEffect(() => {
    return paneVisibilityStore.subscribeRequests(({ pane, open }) => {
      if (noteWindow) return;
      if (pane === 'agents' && !agentsAvailable) return;
      if (exclusive) {
        if (pane === 'terminal' && !terminalAvailable) return;
        applyPaneRequest(pane, open);
        return;
      }
      switch (pane) {
        case 'editor':
          if (!editorToggleable) return;
          applyPaneRequest(pane, open);
          editorChosenSinceMountRef.current = true;
          setEditorShown(open);
          return;
        case 'agents':
          applyPaneRequest(pane, open);
          setAgentsVisible(open);
          return;
        case 'terminal':
          applyPaneRequest(pane, open);
          if (terminalAvailable) setTerminalVisible(open);
          return;
        default:
          return assertNeverPaneId(pane);
      }
    });
  }, [
    noteWindow,
    agentsAvailable,
    terminalAvailable,
    editorToggleable,
    exclusive,
    applyPaneRequest,
  ]);

  const { projectConfig, projectLocalConfig, projectLocalSynced, projectSynced } =
    useConfigContext();

  const { activeDocName, activeProvider } = useDocumentContext();
  const editingSurface = editingSurfaceFor(activeDocName, editorMode);

  const autoSyncOnboardingVariant = resolveAutoSyncOnboarding({
    autoSyncOnboardingDismissed,
    hasRemote: syncStatus?.hasRemote,
    projectLocalSynced,
    projectSynced,
    projectLocalConfig,
    projectConfig,
    pushPermissionCheckStatus: syncStatus?.pushPermission?.checkStatus,
  });

  useEffect(() => {
    function onRawMdxNav(e: Event) {
      const detail = (e as CustomEvent<RawMdxNavDetail>).detail;
      if (detail && activeDocName) {
        rememberPendingSourceNavigation(activeDocName, { kind: 'raw-mdx', detail });
      }
      setEditorMode('source');
    }
    window.addEventListener(RAW_MDX_NAV_EVENT, onRawMdxNav);
    return () => window.removeEventListener(RAW_MDX_NAV_EVENT, onRawMdxNav);
  }, [activeDocName]);

  const toggleEditorEvent = useEffectEvent(() => {
    if (!editorToggleable) return;
    if (exclusive) {
      if (effectiveEditorVisible) hidePane('editor');
      else selectPane('editor');
      return;
    }
    editorChosenSinceMountRef.current = true;
    if (editorShown) hidePane('editor');
    else selectPane('editor');
    setEditorShown(!editorShown);
  });
  const toggleAgentsEvent = useEffectEvent(() => {
    handleAgentsVisibleChange(!effectiveAgentsVisible);
  });
  const toggleTerminalEvent = useEffectEvent(() =>
    handleTerminalVisibleChange(!effectiveTerminalVisible),
  );
  const showTerminalEvent = useEffectEvent(() => handleTerminalVisibleChange(true));

  useEffect(() => {
    if (noteWindow) return;
    return subscribeLocalMenuAction((action) => {
      if (action === 'toggle-terminal') {
        toggleTerminalEvent();
      } else if (action === 'move-terminal') {
        moveTerminalEvent();
      } else if (action === 'new-terminal') {
        showTerminalEvent();
      } else if (action === 'toggle-agent-panel') {
        if (!agentsAvailable) return;
        toggleAgentsEvent();
      } else if (action === 'toggle-editor') {
        toggleEditorEvent();
      }
    });
  }, [noteWindow, agentsAvailable]);

  useEffect(() => {
    const hasNativeMenu = window.okDesktop != null;
    function handleKeyDown(event: KeyboardEvent) {
      if (!matchesRendererShortcut(event, 'toggle-terminal-panel', hasNativeMenu)) return;
      if (isOverlayLayerOpen()) return;
      if (!terminalAvailable) return;
      event.preventDefault();
      toggleTerminalEvent();
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [terminalAvailable]);

  useEffect(() => {
    if (window.okDesktop != null) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (!agentsAvailable) return;
      if (!matchesKeyboardShortcut(event, 'toggle-agent-panel')) return;
      if (isOverlayLayerOpen()) return;
      event.preventDefault();
      toggleAgentsEvent();
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [agentsAvailable]);

  useEffect(() => {
    if (window.okDesktop == null) return;
    noteRestoreVisibilityLevel(terminalRestoreGateRef, terminalVisible);
    if (!dockRestoreSettled) return;
    if (!consumeRestoreVisibilityGate(terminalRestoreGateRef)) return;
    window.okDesktop.editor.notifyViewMenuStateChanged({
      terminalVisible: effectiveTerminalVisible,
      wideIntent: { terminalVisible },
    });
  }, [terminalVisible, effectiveTerminalVisible, dockRestoreSettled]);

  useEffect(() => {
    if (window.okDesktop == null) return;
    if (!dockRestoreSettled) return;
    setViewMenuState({ terminalPlacement });
    window.okDesktop.editor.notifyViewMenuStateChanged({ terminalPlacement });
  }, [terminalPlacement, dockRestoreSettled]);

  useEffect(() => {
    if (window.okDesktop == null) return;
    noteRestoreVisibilityLevel(agentsRestoreGateRef, agentsVisible);
    if (!dockRestoreSettled) return;
    if (!consumeRestoreVisibilityGate(agentsRestoreGateRef)) return;
    window.okDesktop.editor.notifyViewMenuStateChanged({
      agentPanelVisible: effectiveAgentsVisible,
      wideIntent: { agentPanelVisible: agentsVisible },
    });
  }, [agentsVisible, effectiveAgentsVisible, dockRestoreSettled]);

  useEffect(() => {
    if (desktopBridge != null || !editorToggleable) return;
    saveBoolPref(WEB_EDITOR_VISIBLE_KEY, editorShown, true);
  }, [desktopBridge, editorToggleable, editorShown]);

  useEffect(() => {
    if (window.okDesktop == null || !editorToggleable) return;
    noteRestoreVisibilityLevel(editorRestoreGateRef, editorShown);
    if (!dockRestoreSettled && !editorChosenSinceMountRef.current) return;
    if (dockRestoreSettled && !consumeRestoreVisibilityGate(editorRestoreGateRef)) return;
    window.okDesktop.editor.notifyViewMenuStateChanged({
      editorVisible: effectiveEditorVisible,
      wideIntent: { editorVisible: editorShown },
    });
  }, [editorShown, effectiveEditorVisible, dockRestoreSettled, editorToggleable]);

  useEffect(() => {
    setViewMenuState({
      editorVisible: effectiveEditorVisible,
      agentPanelVisible: effectiveAgentsVisible,
      terminalVisible: effectiveTerminalVisible,
    });
  }, [effectiveEditorVisible, effectiveAgentsVisible, effectiveTerminalVisible]);

  useEffect(() => {
    let last: boolean | null = null;
    const publish = () => {
      const snapshot =
        activeDocName === null ? null : getSelectionContext(activeDocName, editingSurface);
      const hasEditorSelection = effectiveEditorVisible && (snapshot?.markdown ?? '').trim() !== '';
      if (hasEditorSelection === last) return;
      last = hasEditorSelection;
      setViewMenuState({ hasEditorSelection });
      window.okDesktop?.editor.notifyViewMenuStateChanged({ hasEditorSelection });
    };
    publish();
    return subscribeSelectionContext(publish);
  }, [activeDocName, editingSurface, effectiveEditorVisible]);

  useEffect(() => {
    if (noteWindow) {
      setDockRestoreSettled(true);
      return;
    }
    const bridge = window.okDesktop;
    if (bridge == null) return;
    if (typeof bridge.terminal?.getDockState !== 'function') {
      setDockRestoreSettled(true);
      return;
    }
    let cancelled = false;
    let abandoned = false;
    const restoreDeadline = window.setTimeout(() => {
      abandoned = true;
      armRestoreVisibilityGate(terminalRestoreGateRef);
      armRestoreVisibilityGate(agentsRestoreGateRef);
      armRestoreVisibilityGate(editorRestoreGateRef);
      console.warn(
        `[dock] dock-state restore exceeded its ${RESTORE_SETTLE_TIMEOUT_MS}ms bound; the agents panel and terminal start closed and the editor starts shown until the read lands; a read that still lands reveals nothing, and hides the editor only when the saved layout had no pane open and the user has not chosen an editor level since mount; each level still unrestored is withheld from the view menu and the dock record, so a later reveal or toggle still publishes`,
      );
      setDockRestoreSettled(true);
    }, RESTORE_SETTLE_TIMEOUT_MS);
    void bridge.terminal
      .getDockState()
      .then((state) => {
        if (cancelled) return;
        if (abandoned) {
          const savedLayoutHadNoPaneOpen =
            state.editorVisible === false &&
            !state.terminalVisible &&
            state.agentPanelVisible !== true;
          if (savedLayoutHadNoPaneOpen && !editorChosenSinceMountRef.current) setEditorShown(false);
          return;
        }
        setAgentsVisible((current) => (current ? current : state.agentPanelVisible === true));
        if (!editorChosenSinceMountRef.current) setEditorShown(state.editorVisible !== false);
        if (!state.terminalVisible) return;
        setTerminalVisible(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (!abandoned) {
          armRestoreVisibilityGate(terminalRestoreGateRef);
          armRestoreVisibilityGate(agentsRestoreGateRef);
          armRestoreVisibilityGate(editorRestoreGateRef);
        }
        console.error(
          '[dock] dock-state restore failed; the agents panel and terminal start closed and the editor starts shown without its saved state applied; each un-restored level is withheld from the view menu and the dock record, so a later reveal or toggle still publishes:',
          err,
        );
      })
      .finally(() => {
        window.clearTimeout(restoreDeadline);
        if (!cancelled) setDockRestoreSettled(true);
      });
    return () => {
      cancelled = true;
      abandoned = true;
      window.clearTimeout(restoreDeadline);
      resetRestoreVisibilityGate(terminalRestoreGateRef);
      resetRestoreVisibilityGate(agentsRestoreGateRef);
      resetRestoreVisibilityGate(editorRestoreGateRef);
    };
  }, [noteWindow]);

  useNoPushPermissionToast(syncStatus?.pausedReason);

  useWorktreeAutoSyncNotice();

  const handleModeChange = useModeChangeHandler({
    docName: activeDocName,
    provider: activeProvider,
    mode: editorMode,
    setMode: setEditorMode,
    setPersistedMode,
  });

  const toggleEditorModeEvent = useEffectEvent(() => {
    handleModeChange(editorMode === 'source' ? 'wysiwyg' : 'source');
  });
  const canViewInSource =
    editorMode === 'wysiwyg' && Boolean(activeDocName) && Boolean(activeProvider);

  const requestViewInSourceEvent = useEffectEvent(() => {
    if (!canViewInSource || !activeDocName || !activeProvider) return;
    revealEditorBeforeActing();
    const editor = getEditorForDoc(activeDocName);
    if (!editor) return;
    requestViewInSource({
      editor,
      docName: activeDocName,
      ytext: activeProvider.document.getText('source'),
    });
  });

  useEffect(() => {
    window.okDesktop?.editor.notifyViewMenuStateChanged({ canViewInSource });
  }, [canViewInSource]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (matchesKeyboardShortcut(event, 'toggle-editor-mode')) {
        if (isOverlayLayerOpen()) return;
        event.preventDefault();
        toggleEditorModeEvent();
        return;
      }
      if (matchesKeyboardShortcut(event, 'view-source-at-cursor')) {
        if (isOverlayLayerOpen()) return;
        event.preventDefault();
        requestViewInSourceEvent();
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'toggle-source') requestViewInSourceEvent();
    });
  }, []);

  useEffect(() => {
    function onViewInSource(e: Event) {
      const detail = (e as CustomEvent<ViewInSourceDetail>).detail;
      if (detail?.docName === activeDocName) setEditorMode('source');
    }
    window.addEventListener(VIEW_IN_SOURCE_EVENT, onViewInSource);
    return () => window.removeEventListener(VIEW_IN_SOURCE_EVENT, onViewInSource);
  }, [activeDocName]);

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <EditorArea
            ref={editorAreaRef}
            onPaneExtentChange={publishPaneVisibility}
            editorMode={editorMode}
            onModeChange={handleModeChange}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
            terminalBridge={terminalAvailable ? desktopBridge : null}
            editorVisible={effectiveEditorVisible}
            terminalVisible={noteWindow ? false : effectiveTerminalVisible}
            agentsVisible={agentsAvailable ? effectiveAgentsVisible : false}
            dockTree={dockTree}
            onDockTreeChange={changeDockTree}
            onSessionPlacements={setPlacements}
            renderWorkspaceHeader={createWorkspaceHeaderRenderer({
              noteWindow,
              activeDocName,
              activeProvider,
              editorMode,
              onModeChange: handleModeChange,
            })}
          />
        </div>
      </div>
      {chatPane ? (
        <ChatPaneHost
          container={placements.agents.container}
          isShowing={placements.agents.isShowing}
        />
      ) : null}
      <AuthModal
        open={authModalOpen}
        onOpenChange={setAuthModalOpen}
        identityPrompt={authInitialStep === 'identity'}
        onSuccess={() => {
          setAuthModalOpen(false);
        }}
      />
      <AutoSyncOnboardingDialog
        open={autoSyncOnboardingVariant !== null}
        variant={autoSyncOnboardingVariant ?? 'full'}
        onResolved={() => setAutoSyncOnboardingDismissed(true)}
      />
      <TagDialog />
      <EmojiInsertPopover />
    </>
  );
}
