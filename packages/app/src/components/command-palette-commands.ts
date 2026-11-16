import {
  COMMAND_IDENTITIES,
  type CommandContext,
  type CommandIdentity,
  DOCK_MOVE_COMMANDS,
  type DockMoveSide,
  evaluateCommandAvailability,
} from '@gitquire/core/commands/command-identity';
import {
  OPEN_KNOWLEDGE_DOCS_URL,
  OPEN_KNOWLEDGE_GITHUB_URL,
  OPEN_KNOWLEDGE_ISSUES_URL,
} from '@gitquire/core/constants/menu-labels';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  ArrowLeftRight,
  BookOpen,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  FoldVertical,
  Gamepad2,
  MessageSquare,
  Network,
  Package,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Settings,
  UnfoldVertical,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { GithubIcon } from '@/components/icons/github';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import { PANE_ICON } from '@/components/pane-icons';
import type { OkMenuAction } from '@/lib/desktop-bridge-types';
import { requestDockPaneMove } from '@/lib/dock-move-requests';
import { i18n } from '@/lib/i18n';
import type { KeyboardShortcutId } from '@/lib/keyboard-shortcuts';
import { paneVisibilityStore } from '@/lib/pane-visibility-store';
import { moveChatHistory, type PhysicalSide, swapEditorSidebars } from '@/lib/sidebar-side-store';
import { openSettings } from '@/lib/use-settings-route';
import type { ViewMenuState } from '@/lib/view-menu-state-store';

export type ContextualTargetKind = 'doc' | 'folder' | 'asset' | 'none';

export function projectContextualTargetKind(
  target: ResolvedNavigationTarget | null,
): ContextualTargetKind {
  if (target === null) return 'none';
  switch (target.kind) {
    case 'doc':
    case 'folder-index':
      return 'doc';
    case 'folder':
      return 'folder';
    case 'asset':
    case 'large-file':
      return 'asset';
    case 'missing':
      return 'none';
  }
}

export interface PaletteCommandContext {
  singleFile: boolean;
  activeDocName: string | null;
  contextualTargetKind: ContextualTargetKind;
  viewMenuState: ViewMenuState;
  chatHistorySide: PhysicalSide;
  emitMenuAction(action: OkMenuAction): void;
  runAction(fn: () => Promise<void> | void, fallback?: string): void;
  openExternalUrl(url: string): void;
  closePalette(): void;
  openNewItemDialog(kind: 'file' | 'folder'): void;
  openSeedDialog(): void;
  openFeedbackDialog(): void;
  openBlobRun(): void;
}

export type PaletteCommandGroup = 'commands' | 'project' | 'file' | 'view' | 'app';

export interface PaletteCommand {
  id: string;
  menuActionId?: OkMenuAction;
  label(ctx: PaletteCommandContext): string;
  keywords: readonly string[];
  icon: ComponentType<{ className?: string }>;
  group: PaletteCommandGroup;
  visibility: 'always' | 'search-only';
  shortcutId?: KeyboardShortcutId;
  shortcutDesktopOnly?: boolean;
  checked?(ctx: PaletteCommandContext): boolean;
  available(ctx: PaletteCommandContext): boolean;
  dispatch(ctx: PaletteCommandContext): void;
}

const PALETTE_COMMAND_LABELS = {
  blobRun: msg`Blob Run`,
  newFile: msg`New file`,
  newFolder: msg`New folder`,
  openGraph: msg`Open graph`,
  initializeStarterPack: msg`Initialize starter pack`,
  settings: msg`Settings`,
  sendFeedback: msg`Send feedback`,
  newFromTemplate: msg`New from template`,
  sidebarShow: msg`Show sidebar`,
  sidebarHide: msg`Hide sidebar`,
  docPanelShow: msg`Show document panel`,
  docPanelHide: msg`Hide document panel`,
  swapEditorSidebars: msg`Swap file sidebar and document panel`,
  chatHistoryMoveLeft: msg`Move chat history to the left`,
  chatHistoryMoveRight: msg`Move chat history to the right`,
  editorShow: msg`Show Editor`,
  editorHide: msg`Hide Editor`,
  agentPanelShow: msg`Show Agents`,
  agentPanelHide: msg`Hide Agents`,
  editorMoveToLeftEdge: msg`Move Editor to the left edge of the window`,
  editorMoveToRightEdge: msg`Move Editor to the right edge of the window`,
  editorMoveToTopEdge: msg`Move Editor to the top edge of the window`,
  editorMoveToBottomEdge: msg`Move Editor to the bottom edge of the window`,
  agentsMoveToLeftEdge: msg`Move Agents to the left edge of the window`,
  agentsMoveToRightEdge: msg`Move Agents to the right edge of the window`,
  agentsMoveToTopEdge: msg`Move Agents to the top edge of the window`,
  agentsMoveToBottomEdge: msg`Move Agents to the bottom edge of the window`,
  showHiddenFiles: msg`Show hidden files`,
  showOkFolders: msg`Show .ok folders`,
  showOnlyMarkdownFiles: msg`Show only markdown files`,
  expandAll: msg`Expand all`,
  collapseAll: msg`Collapse all`,
  openOnGithub: msg`GitQuire on GitHub`,
  openDocs: msg`Documentation`,
  joinDiscord: msg`Report an issue on GitHub`,
} as const satisfies Record<string, MessageDescriptor>;

export type PaletteLabelKey = keyof typeof PALETTE_COMMAND_LABELS;
export { PALETTE_COMMAND_LABELS };

function paletteLabelDescriptor(key: PaletteLabelKey): MessageDescriptor {
  return PALETTE_COMMAND_LABELS[key];
}

const DOCK_SIDE_ICON = {
  left: PanelLeft,
  right: PanelRight,
  top: PanelTop,
  bottom: PanelBottom,
} as const satisfies Record<DockMoveSide, ComponentType<{ className?: string }>>;

const COMMAND_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  ...Object.fromEntries(
    DOCK_MOVE_COMMANDS.map((command) => [command.id, DOCK_SIDE_ICON[command.side]]),
  ),
  'open-blob-run': Gamepad2,
  'new-file': FilePlus2,
  'new-folder': FolderPlus,
  'open-graph': Network,
  'initialize-starter-pack': Package,
  settings: Settings,
  'send-feedback': MessageSquare,
  'new-from-template': FilePlus2,
  'toggle-sidebar': PanelLeft,
  'toggle-doc-panel': PanelRight,
  'swap-editor-sidebars': ArrowLeftRight,
  'move-chat-history-left': PanelLeft,
  'move-chat-history-right': PanelRight,
  'toggle-agent-panel': PANE_ICON.agents,
  'toggle-editor': PANE_ICON.editor,
  'toggle-show-hidden-files': Eye,
  'toggle-show-ok-folders': Folder,
  'toggle-show-only-markdown-files': FileText,
  'expand-all-tree': UnfoldVertical,
  'collapse-all-tree': FoldVertical,
  'open-github': GithubIcon,
  'open-docs': BookOpen,
  'open-discord': GithubIcon,
};

const COMMAND_DISPATCH: Record<string, (ctx: PaletteCommandContext) => void> = {
  ...Object.fromEntries(
    DOCK_MOVE_COMMANDS.map((command) => [
      command.id,
      (ctx: PaletteCommandContext) => {
        ctx.closePalette();
        requestDockPaneMove({ pane: command.pane, side: command.side });
      },
    ]),
  ),
  'swap-editor-sidebars': (ctx) => {
    ctx.closePalette();
    swapEditorSidebars();
  },
  'move-chat-history-left': (ctx) => {
    ctx.closePalette();
    moveChatHistory('left');
  },
  'move-chat-history-right': (ctx) => {
    ctx.closePalette();
    moveChatHistory('right');
  },
  'open-blob-run': (ctx) => ctx.openBlobRun(),
  'new-file': (ctx) => {
    ctx.closePalette();
    ctx.openNewItemDialog('file');
  },
  'new-folder': (ctx) => {
    ctx.closePalette();
    ctx.openNewItemDialog('folder');
  },
  'open-graph': (ctx) => {
    ctx.closePalette();
    requestDocPanelTab('graph');
  },
  'initialize-starter-pack': (ctx) => {
    ctx.closePalette();
    ctx.openSeedDialog();
  },
  settings: (ctx) => {
    ctx.closePalette();
    openSettings();
  },
  'send-feedback': (ctx) => ctx.openExternalUrl(OPEN_KNOWLEDGE_ISSUES_URL),
  'open-github': (ctx) => ctx.openExternalUrl(OPEN_KNOWLEDGE_GITHUB_URL),
  'open-docs': (ctx) => ctx.openExternalUrl(OPEN_KNOWLEDGE_DOCS_URL),
  'open-discord': (ctx) => ctx.openExternalUrl(OPEN_KNOWLEDGE_ISSUES_URL),
};

const STATE_AVAILABILITY: Readonly<
  Partial<Record<string, (ctx: PaletteCommandContext) => boolean>>
> = {
  'move-chat-history-left': (ctx) => ctx.chatHistorySide === 'right',
  'move-chat-history-right': (ctx) => ctx.chatHistorySide === 'left',
  'toggle-agent-panel': () => paneVisibilityStore.getSnapshot().agents !== null,
};

function paletteCoreContext(ctx: PaletteCommandContext): CommandContext {
  return {
    activeTargetKind: ctx.contextualTargetKind,
    singleFile: ctx.singleFile,
    canExpandAll: ctx.viewMenuState.canExpandAll !== false,
    canCollapseAll: ctx.viewMenuState.canCollapseAll !== false,
    hasActiveDoc: ctx.activeDocName !== null,
  };
}

function resolvePaletteLabel(cmd: CommandIdentity, ctx: PaletteCommandContext): string {
  if (cmd.stateToggle) {
    const { overrideKey, overrideField } = cmd.stateToggle;
    if (
      overrideKey !== undefined &&
      overrideField !== undefined &&
      ctx.viewMenuState[overrideField] === true
    ) {
      return i18n._(PALETTE_COMMAND_LABELS[overrideKey as PaletteLabelKey]);
    }
    const visible =
      (ctx.viewMenuState[cmd.stateToggle.stateField] ?? cmd.stateToggle.defaultVisible) === true;
    const key = visible ? cmd.stateToggle.hideKey : cmd.stateToggle.showKey;
    return i18n._(paletteLabelDescriptor(key as PaletteLabelKey));
  }
  return i18n._(paletteLabelDescriptor(cmd.labelKey as PaletteLabelKey));
}

function busDispatch(cmd: CommandIdentity): (ctx: PaletteCommandContext) => void {
  const action = cmd.menuActionId as OkMenuAction;
  return (ctx) => ctx.emitMenuAction(action);
}

function toPaletteCommand(cmd: CommandIdentity): PaletteCommand {
  const presence = cmd.palette;
  if (!presence) throw new Error(`command ${cmd.id} has no palette presence`);
  const icon = COMMAND_ICONS[cmd.id];
  if (!icon) throw new Error(`command ${cmd.id} has no palette icon`);
  const checkField = cmd.checkField;
  return {
    id: cmd.id,
    menuActionId: cmd.menuActionId as OkMenuAction | undefined,
    label: (ctx) => resolvePaletteLabel(cmd, ctx),
    keywords: cmd.keywords,
    icon,
    group: presence.group,
    visibility: presence.visibility,
    shortcutId: cmd.shortcutId as KeyboardShortcutId | undefined,
    shortcutDesktopOnly: cmd.shortcutDesktopOnly,
    checked: checkField ? (ctx) => ctx.viewMenuState[checkField] === true : undefined,
    available: (ctx) =>
      evaluateCommandAvailability(cmd.availability, paletteCoreContext(ctx)) &&
      (STATE_AVAILABILITY[cmd.id]?.(ctx) ?? true),
    dispatch: COMMAND_DISPATCH[cmd.id] ?? busDispatch(cmd),
  };
}

export const PALETTE_COMMANDS: readonly PaletteCommand[] = COMMAND_IDENTITIES.flatMap((cmd) =>
  cmd.palette ? [toPaletteCommand(cmd)] : [],
);
