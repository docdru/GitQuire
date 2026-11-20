import type { MenuLabelKey } from '../constants/menu-labels.ts';

export type CommandGroup = 'commands' | 'project' | 'file' | 'view' | 'app';

export type ContextualTargetKind = 'doc' | 'folder' | 'asset' | 'project' | 'none';

export interface CommandAvailabilitySpec {
  readonly requiresTargetKinds?: readonly ContextualTargetKind[];
  readonly requiresCanExpandAll?: boolean;
  readonly requiresCanCollapseAll?: boolean;
  readonly requiresActiveDoc?: boolean;
}

export interface CommandContext {
  readonly activeTargetKind: ContextualTargetKind;
  readonly canExpandAll: boolean;
  readonly canCollapseAll: boolean;
  readonly hasActiveDoc: boolean;
}

export function evaluateCommandAvailability(
  spec: CommandAvailabilitySpec,
  ctx: CommandContext,
): boolean {
  if (spec.requiresCanExpandAll && !ctx.canExpandAll) return false;
  if (spec.requiresCanCollapseAll && !ctx.canCollapseAll) return false;
  if (spec.requiresActiveDoc && !ctx.hasActiveDoc) return false;
  if (spec.requiresTargetKinds && !spec.requiresTargetKinds.includes(ctx.activeTargetKind)) {
    return false;
  }
  return true;
}

export type MenuPlatform = 'all' | 'mac' | 'other';

export type MenuSection =
  | 'app-updates'
  | 'app-settings'
  | 'app-uninstall'
  | 'file-create'
  | 'file-project'
  | 'file-worktree'
  | 'file-item'
  | 'file-reveal'
  | 'file-copy-path'
  | 'file-integrations'
  | 'file-settings'
  | 'file-close'
  | 'edit-spell'
  | 'view-panels'
  | 'view-visibility'
  | 'view-tree'
  | 'view-history'
  | 'window'
  | 'help-install'
  | 'help-links'
  | 'help-updates';

export interface CommandMenuPlacement {
  readonly section: MenuSection;
  readonly order: number;
  readonly platform?: MenuPlatform;
  readonly accelerator?: string;
  readonly ellipsis?: boolean;
  readonly checkbox?: boolean;
  readonly smartHide?: boolean;
  readonly menuLabelKey?: MenuLabelKey;
  readonly menuLabelText?: string;
}

export interface CommandStateToggle {
  readonly showKey: MenuLabelKey;
  readonly hideKey: MenuLabelKey;
  readonly stateField: 'sidebarVisible' | 'docPanelVisible' | 'agentPanelVisible' | 'editorVisible';
  readonly defaultVisible: boolean;
  readonly overrideKey?: MenuLabelKey;
  readonly overrideField?: 'hasEditorSelection';
}

export type CommandCheckField = 'showHiddenFiles' | 'showOkFolders' | 'showOnlyMarkdownFiles';

export interface CommandPalettePresence {
  readonly group: CommandGroup;
  readonly visibility: 'always' | 'search-only';
}

export interface CommandIdentity {
  readonly id: string;
  readonly menuActionId?: string;
  readonly labelKey?: MenuLabelKey;
  readonly keywords: readonly string[];
  readonly shortcutId?: string;
  readonly stateToggle?: CommandStateToggle;
  readonly checkField?: CommandCheckField;
  readonly availability: CommandAvailabilitySpec;
  readonly palette?: CommandPalettePresence;
  readonly menu?: readonly CommandMenuPlacement[];
}

export type PaneId = 'editor' | 'agents';

export type DockMoveSide = 'left' | 'right' | 'top' | 'bottom';

export interface DockMoveCommand {
  readonly id: string;
  readonly pane: PaneId;
  readonly side: DockMoveSide;
  readonly labelKey: MenuLabelKey;
}

const DOCK_MOVE_LABELS = {
  editor: {
    left: 'editorMoveToLeftEdge',
    right: 'editorMoveToRightEdge',
    top: 'editorMoveToTopEdge',
    bottom: 'editorMoveToBottomEdge',
  },
  agents: {
    left: 'agentsMoveToLeftEdge',
    right: 'agentsMoveToRightEdge',
    top: 'agentsMoveToTopEdge',
    bottom: 'agentsMoveToBottomEdge',
  },
} as const satisfies Record<PaneId, Record<DockMoveSide, MenuLabelKey>>;

const DOCK_MOVE_PANE_ALIASES = {
  editor: ['document'],
  agents: ['chat', 'ai'],
} as const satisfies Record<PaneId, readonly string[]>;

const DOCK_MOVE_SIDES: readonly DockMoveSide[] = ['left', 'right', 'top', 'bottom'];

export const DOCK_MOVE_COMMANDS: readonly DockMoveCommand[] = (
  Object.keys(DOCK_MOVE_LABELS) as PaneId[]
).flatMap((pane) =>
  DOCK_MOVE_SIDES.map((side) => ({
    id: `move-${pane}-${side}`,
    pane,
    side,
    labelKey: DOCK_MOVE_LABELS[pane][side],
  })),
);

function dockMoveIdentity(command: DockMoveCommand): CommandIdentity {
  return {
    id: command.id,
    labelKey: command.labelKey,
    keywords: [
      'move',
      'dock',
      'pane',
      'layout',
      'edge',
      command.pane,
      ...DOCK_MOVE_PANE_ALIASES[command.pane],
      command.side,
    ],
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
  };
}

export const COMMAND_IDENTITIES: readonly CommandIdentity[] = [
  {
    id: 'open-blob-run',
    labelKey: 'blobRun',
    keywords: ['game', 'blob', 'runner', 'play', 'easter egg', 'dino'],
    availability: {},
    palette: { group: 'app', visibility: 'search-only' },
  },
  {
    id: 'new-file',
    menuActionId: 'new-doc',
    labelKey: 'newFile',
    keywords: ['create file', 'document', 'note'],
    shortcutId: 'new-item',
    availability: {},
    palette: { group: 'commands', visibility: 'always' },
    menu: [{ section: 'file-create', order: 0, accelerator: 'CmdOrCtrl+Alt+N' }],
  },
  {
    id: 'new-folder',
    menuActionId: 'new-folder',
    labelKey: 'newFolder',
    keywords: ['create folder', 'directory'],
    availability: {},
    palette: { group: 'commands', visibility: 'always' },
    menu: [{ section: 'file-create', order: 1, accelerator: 'CmdOrCtrl+Shift+N' }],
  },
  {
    id: 'open-graph',
    labelKey: 'openGraph',
    keywords: ['graph panel network', 'show', 'view'],
    availability: { requiresActiveDoc: true },
    palette: { group: 'commands', visibility: 'always' },
  },
  {
    id: 'initialize-starter-pack',
    labelKey: 'initializeStarterPack',
    keywords: ['scaffold', 'seed', 'pack', 'starter'],
    availability: {},
    palette: { group: 'commands', visibility: 'always' },
  },
  {
    id: 'settings',
    labelKey: 'settings',
    keywords: ['preferences config', 'open'],
    shortcutId: 'settings',
    availability: {},
    palette: { group: 'project', visibility: 'always' },
    menu: [
      {
        section: 'app-settings',
        order: 0,
        platform: 'mac',
        accelerator: 'CmdOrCtrl+,',
        ellipsis: true,
      },
      {
        section: 'file-settings',
        order: 0,
        platform: 'other',
        accelerator: 'CmdOrCtrl+,',
        ellipsis: true,
      },
    ],
  },
  {
    id: 'send-feedback',
    menuActionId: 'send-feedback',
    labelKey: 'sendFeedback',
    keywords: ['feedback', 'suggestion', 'idea', 'rate', 'survey', 'contact', 'give'],
    availability: {},
    palette: { group: 'project', visibility: 'always' },
    menu: [{ section: 'help-links', order: 4, ellipsis: true }],
  },
  {
    id: 'new-from-template',
    menuActionId: 'new-from-template',
    labelKey: 'newFromTemplate',
    keywords: ['template', 'create', 'new'],
    availability: {},
    palette: { group: 'file', visibility: 'search-only' },
    menu: [{ section: 'file-create', order: 2, ellipsis: true }],
  },
  {
    id: 'toggle-sidebar',
    menuActionId: 'toggle-sidebar',
    labelKey: 'sidebarHide',
    keywords: ['sidebar', 'files', 'panel', 'toggle', 'show', 'hide', 'open'],
    shortcutId: 'toggle-files-sidebar',
    stateToggle: {
      showKey: 'sidebarShow',
      hideKey: 'sidebarHide',
      stateField: 'sidebarVisible',
      defaultVisible: true,
    },
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-panels', order: 0, accelerator: 'CmdOrCtrl+Alt+S' }],
  },
  {
    id: 'toggle-doc-panel',
    menuActionId: 'toggle-doc-panel',
    labelKey: 'docPanelHide',
    keywords: ['document', 'panel', 'info', 'toggle', 'properties', 'show', 'hide', 'open'],
    shortcutId: 'toggle-document-panel',
    stateToggle: {
      showKey: 'docPanelShow',
      hideKey: 'docPanelHide',
      stateField: 'docPanelVisible',
      defaultVisible: true,
    },
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-panels', order: 1, accelerator: 'CmdOrCtrl+Alt+B' }],
  },
  {
    id: 'swap-editor-sidebars',
    labelKey: 'swapEditorSidebars',
    keywords: [
      'sidebar',
      'file',
      'files',
      'document',
      'panel',
      'swap',
      'move',
      'side',
      'left',
      'right',
      'position',
    ],
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
  },
  {
    id: 'move-chat-history-left',
    labelKey: 'chatHistoryMoveLeft',
    keywords: [
      'chat',
      'history',
      'conversations',
      'agents',
      'sidebar',
      'move',
      'side',
      'left',
      'position',
    ],
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
  },
  {
    id: 'move-chat-history-right',
    labelKey: 'chatHistoryMoveRight',
    keywords: [
      'chat',
      'history',
      'conversations',
      'agents',
      'sidebar',
      'move',
      'side',
      'right',
      'position',
    ],
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
  },
  {
    id: 'toggle-editor',
    menuActionId: 'toggle-editor',
    labelKey: 'editorShow',
    keywords: ['editor', 'document', 'pane', 'panel', 'show editor', 'hide editor'],
    stateToggle: {
      showKey: 'editorShow',
      hideKey: 'editorHide',
      stateField: 'editorVisible',
      defaultVisible: true,
    },
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-panels', order: 2 }],
  },
  {
    id: 'toggle-agent-panel',
    menuActionId: 'toggle-agent-panel',
    labelKey: 'agentPanelShow',
    keywords: ['agent', 'agents', 'chat', 'ai', 'ask', 'panel', 'toggle', 'open', 'show', 'hide'],
    shortcutId: 'toggle-agent-panel',
    stateToggle: {
      showKey: 'agentPanelShow',
      hideKey: 'agentPanelHide',
      stateField: 'agentPanelVisible',
      defaultVisible: false,
    },
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-panels', order: 4, accelerator: 'CmdOrCtrl+Alt+A' }],
  },
  {
    id: 'toggle-show-hidden-files',
    menuActionId: 'toggle-show-hidden-files',
    labelKey: 'showHiddenFiles',
    keywords: ['hidden', 'dotfiles', 'files', 'show'],
    checkField: 'showHiddenFiles',
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [
      { section: 'view-visibility', order: 0, accelerator: 'CmdOrCtrl+Shift+.', checkbox: true },
    ],
  },
  {
    id: 'toggle-show-ok-folders',
    menuActionId: 'toggle-show-ok-folders',
    labelKey: 'showOkFolders',
    keywords: ['ok', 'folders', 'hidden', 'show'],
    checkField: 'showOkFolders',
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-visibility', order: 1, checkbox: true }],
  },
  {
    id: 'toggle-show-only-markdown-files',
    menuActionId: 'toggle-show-only-markdown-files',
    labelKey: 'showOnlyMarkdownFiles',
    keywords: ['markdown', 'filter', 'files', 'only'],
    checkField: 'showOnlyMarkdownFiles',
    availability: {},
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-visibility', order: 2, checkbox: true }],
  },
  {
    id: 'expand-all-tree',
    menuActionId: 'expand-all-tree',
    labelKey: 'expandAll',
    keywords: ['expand', 'tree', 'folders', 'all'],
    availability: { requiresCanExpandAll: true },
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-tree', order: 0, smartHide: true }],
  },
  {
    id: 'collapse-all-tree',
    menuActionId: 'collapse-all-tree',
    labelKey: 'collapseAll',
    keywords: ['collapse', 'tree', 'folders', 'all'],
    availability: { requiresCanCollapseAll: true },
    palette: { group: 'view', visibility: 'search-only' },
    menu: [{ section: 'view-tree', order: 1, smartHide: true }],
  },
  {
    id: 'open-github',
    labelKey: 'openOnGithub',
    keywords: ['github', 'source', 'repository', 'code', 'view'],
    availability: {},
    palette: { group: 'app', visibility: 'search-only' },
    menu: [{ section: 'help-links', order: 0 }],
  },
  {
    id: 'open-docs',
    labelKey: 'openDocs',
    keywords: ['docs', 'documentation', 'help', 'guide', 'manual'],
    availability: {},
    palette: { group: 'app', visibility: 'search-only' },
    menu: [{ section: 'help-links', order: 1 }],
  },
  {
    id: 'open-discord',
    labelKey: 'joinDiscord',
    keywords: ['discord', 'community', 'chat', 'support', 'join'],
    availability: {},
    palette: { group: 'app', visibility: 'search-only' },
    menu: [{ section: 'help-links', order: 2 }],
  },
  ...DOCK_MOVE_COMMANDS.map(dockMoveIdentity),
];
