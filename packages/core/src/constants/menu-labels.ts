export const MENU_LABELS = {
  newFile: 'New file',
  newFolder: 'New folder',
  newFromTemplate: 'New from template',
  openFolder: 'Open folder',
  openFile: 'Open file',
  duplicate: 'Duplicate',
  rename: 'Rename',
  copyPath: 'Copy path',
  fullPath: 'Full path',
  relativePath: 'Relative path',
  showHiddenFiles: 'Show hidden files',
  showOkFolders: 'Show .gitquire folders',
  showOnlyMarkdownFiles: 'Show only markdown files',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  moveToTrash: 'Move to Trash',
  copyFullPath: 'Copy full path',
  openOnGithub: 'GitQuire on GitHub',
  openDocs: 'Documentation',
  joinDiscord: 'Report an issue on GitHub',
  sendFeedback: 'Send feedback',
  switchProject: 'Switch project',
  settings: 'Settings',
  openGraph: 'Open graph',
  blobRun: 'Blob Run',
  initializeStarterPack: 'Initialize starter pack',
  sidebarShow: 'Show sidebar',
  sidebarHide: 'Hide sidebar',
  docPanelShow: 'Show document panel',
  docPanelHide: 'Hide document panel',
  swapEditorSidebars: 'Swap file sidebar and document panel',
  chatHistoryMoveLeft: 'Move chat history to the left',
  chatHistoryMoveRight: 'Move chat history to the right',
  back: 'Back',
  forward: 'Forward',
  editorShow: 'Show Editor',
  editorHide: 'Hide Editor',
  agentPanelShow: 'Show Agents',
  agentPanelHide: 'Hide Agents',
  editorMoveToLeftEdge: 'Move Editor to the left edge of the window',
  editorMoveToRightEdge: 'Move Editor to the right edge of the window',
  editorMoveToTopEdge: 'Move Editor to the top edge of the window',
  editorMoveToBottomEdge: 'Move Editor to the bottom edge of the window',
  agentsMoveToLeftEdge: 'Move Agents to the left edge of the window',
  agentsMoveToRightEdge: 'Move Agents to the right edge of the window',
  agentsMoveToTopEdge: 'Move Agents to the top edge of the window',
  agentsMoveToBottomEdge: 'Move Agents to the bottom edge of the window',
} as const satisfies Record<string, string>;

export type MenuLabelKey = keyof typeof MENU_LABELS;

export const PLATFORM_MENU_LABELS: Partial<
  Record<MenuLabelKey, Partial<Record<'win32' | 'linux', string>>>
> = {
  moveToTrash: { win32: 'Move to Recycle Bin' },
};

export function menuLabelForPlatform(key: MenuLabelKey, platform: string): string {
  const overrides = PLATFORM_MENU_LABELS[key];
  if (overrides && (platform === 'win32' || platform === 'linux')) {
    const override = overrides[platform];
    if (override !== undefined) return override;
  }
  return MENU_LABELS[key];
}

export const OPEN_KNOWLEDGE_GITHUB_URL = 'https://github.com/docdru/GitQuire';
export const OPEN_KNOWLEDGE_DOCS_URL = 'https://docdru.github.io/GitQuire/docs';
export const OPEN_KNOWLEDGE_ISSUES_URL = 'https://github.com/docdru/GitQuire/issues/new/choose';
