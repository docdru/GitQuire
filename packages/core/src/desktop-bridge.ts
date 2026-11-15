import type { LintPluginId } from './markdown/lint/types.ts';
import type { TerminalPlacement } from './terminal-layout.ts';

export type { RecentProjectEntry } from './sharing/index.ts';

export interface OkTerminalRestartTab {
  ordinal: number;
  customLabel: string | null;
}

export interface OkTerminalRestartSnapshot {
  tabs: OkTerminalRestartTab[];
  activeOrdinal: number | null;
}

export interface OkMenuActionOrigin {
  readonly launcherBorne: boolean;
}

export type OkMenuAction =
  | 'new-doc'
  | 'new-folder'
  | 'new-project'
  | 'rename'
  | 'delete'
  | 'close-active-tab-or-window'
  | 'toggle-sidebar'
  | 'toggle-source'
  | 'save-version'
  | 'version-history'
  | 'focus-search'
  | 'focus-command-palette'
  | 'navigate-back'
  | 'navigate-forward'
  | 'new-from-template'
  | 'duplicate'
  | 'move-to-trash'
  | 'reveal-in-finder'
  | 'send-to-ai'
  | 'copy-full-path'
  | 'copy-relative-path'
  | 'toggle-show-hidden-files'
  | 'toggle-show-ok-folders'
  | 'toggle-show-only-markdown-files'
  | 'expand-all-tree'
  | 'collapse-all-tree'
  | 'toggle-doc-panel'
  | 'toggle-terminal'
  | 'move-terminal'
  | 'toggle-agent-panel'
  | 'toggle-editor'
  | 'new-terminal'
  | 'kill-terminal'
  | 'new-worktree'
  | 'switch-worktree'
  | 'send-feedback';

export type OkCheckTargetExistsResult = 'exists' | 'missing' | 'unreadable';

export interface OkHeadBranchInfo {
  readonly currentBranch: string | null;
  readonly headSha: string | null;
  readonly detached: boolean;
}

export interface OkUpdateRelaunchFailedInfo {
  readonly version: string;
  readonly message?: string;
  readonly downloadUrl?: string;
  readonly dismissPending?: boolean;
  readonly reason?: 'no-longer-pending';
}

export type ShareTarget =
  | { readonly kind: 'doc'; readonly docPath: string }
  | { readonly kind: 'folder'; readonly folderPath: string };

export interface OkScaffoldFileEntry {
  path: string;
  kind: 'folder' | 'file';
  contentPreview?: string;
}

export interface OkScaffoldSkipEntry {
  path: string;
  reason: 'already-exists' | 'user-content' | 'glob-collision';
}

export interface OkScaffoldPlan {
  created: OkScaffoldFileEntry[];
  skipped: OkScaffoldSkipEntry[];
  warnings: string[];
  packSkills?: { name: string; pending: boolean; conflict?: boolean }[];
  requiredPlugins?: { id: LintPluginId; pending: boolean }[];
}

export interface OkScaffoldApplyError {
  path: string;
  error: string;
}

export interface OkScaffoldApplyResult {
  applied: number;
  errors: OkScaffoldApplyError[];
  durationMs: number;
  packSkillsInstalled: string[];
  pluginsEnabled: LintPluginId[];
  packSkillConflicts: { name: string; hosts?: string[] }[];
}

export interface OkSeedError {
  kind: 'no-project' | 'prerequisite-missing' | 'invalid-root' | 'internal';
  message: string;
}

export type OkPackId =
  | 'knowledge-base'
  | 'software-lifecycle'
  | 'codebase-wiki'
  | 'plain-notes'
  | 'worldbuilding'
  | 'writing-pipeline'
  | 'entity-vault'
  | 'okf';

export interface OkSeedPackFolderInfo {
  path: string;
  summary: string;
}

export interface OkSeedPackEntryCounts {
  files: number;
  folders: number;
}

export interface OkSeedPackInfo {
  id: OkPackId;
  name: string;
  description: string;
  defaultSubfolder?: string;
  folders: OkSeedPackFolderInfo[];
  entryCounts: OkSeedPackEntryCounts;
}

export type OkSeedPlanResult =
  | { ok: true; plan: OkScaffoldPlan }
  | { ok: false; error: OkSeedError };

export type OkSeedApplyResult =
  | { ok: true; result: OkScaffoldApplyResult }
  | { ok: false; error: OkSeedError };

export type OkSeedListPacksResult =
  | { ok: true; packs: OkSeedPackInfo[] }
  | { ok: false; error: { kind: 'internal'; message: string } };

export type OkLocalOpAuthSignoutResponse = { ok: true } | { ok: false; error?: string };

export type OkLocalOpAuthEvent =
  | {
      type: 'verification';
      user_code: string;
      verification_uri: string;
      expires_in: number;
    }
  | {
      type: 'complete';
      host: string;
      login: string;
      name?: string;
      email?: string;
      avatarUrl?: string;
    }
  | { type: 'error'; message: string };

export type OkLocalOpCloneEvent =
  | { type: 'progress'; phase: string; pct: number }
  | { type: 'complete'; dir: string }
  | { type: 'branch-fallback'; branch: string }
  | {
      type: 'error';
      message: string;
      code?: 'unsafe-symlinks';
      refusedSymlinkPaths?: string[];
    };

export type OkLocalOpAuthStatusResponse =
  | {
      authenticated: true;
      host: string;
      login: string;
      tier?: 'A' | 'B' | 'C';
      name?: string;
      email?: string;
      ghAvailable?: boolean;
    }
  | { authenticated: false; host: string; error?: string; ghAvailable?: boolean };

export interface OkLocalOpRepoEntry {
  full_name: string;
  clone_url: string;
  private: boolean;
}

export type OkLocalOpAuthReposResponse =
  | { ok: true; host: string; repos: OkLocalOpRepoEntry[] }
  | { ok: false; error: string; authenticated?: false };

export interface OkEditorViewMenuStateSnapshot {
  readonly showHiddenFiles: boolean;
  readonly showOkFolders: boolean;
  readonly showOnlyMarkdownFiles: boolean;
  readonly canExpandAll: boolean;
  readonly canCollapseAll: boolean;
  readonly sidebarVisible: boolean;
  readonly docPanelVisible?: boolean;
  readonly terminalVisible?: boolean;
  readonly terminalPlacement?: TerminalPlacement;
  readonly terminalLive?: boolean;
  readonly agentPanelVisible?: boolean;
  readonly editorVisible?: boolean;
  readonly canViewInSource?: boolean;
  readonly hasEditorSelection?: boolean;
}

export interface OkEditorWideVisibility {
  readonly editorVisible?: boolean;
  readonly terminalVisible?: boolean;
  readonly agentPanelVisible?: boolean;
}

type OkEditorDockVisibilityKey = keyof OkEditorWideVisibility;

type OkEditorOnlyPane<K extends OkEditorDockVisibilityKey> = { readonly [P in K]: boolean } & {
  readonly [P in Exclude<OkEditorDockVisibilityKey, K>]?: never;
};

type OkEditorDockVisibilityChange = {
  [K in OkEditorDockVisibilityKey]: OkEditorOnlyPane<K> & {
    readonly wideIntent: OkEditorOnlyPane<K>;
  };
}[OkEditorDockVisibilityKey];

export type OkEditorViewMenuStateChange = Partial<
  Omit<OkEditorViewMenuStateSnapshot, OkEditorDockVisibilityKey>
> &
  (
    | OkEditorDockVisibilityChange
    | ({ readonly [K in OkEditorDockVisibilityKey]?: never } & { readonly wideIntent?: never })
  );

export type OkAssetOpenRefusalReason =
  | 'extension-blocked'
  | 'not-a-file'
  | 'path-escape'
  | 'not-found'
  | 'resolve-error';

export function assetOpenRefusalRevealsInstead(reason: OkAssetOpenRefusalReason): boolean {
  switch (reason) {
    case 'extension-blocked':
    case 'not-a-file':
      return true;
    case 'path-escape':
    case 'not-found':
    case 'resolve-error':
      return false;
    default: {
      const _unknownFromNewerDesktop: never = reason;
      return false;
    }
  }
}

const TERMINAL_SHELL_NOTICE_REASON_VOCABULARY = [
  'config-unreadable',
  'invalid-value',
  'not-absolute',
  'not-found',
  'unsupported-family',
] as const;

export type TerminalShellNoticeReason = (typeof TERMINAL_SHELL_NOTICE_REASON_VOCABULARY)[number];

export const TERMINAL_SHELL_NOTICE_REASONS: ReadonlySet<TerminalShellNoticeReason> = new Set(
  TERMINAL_SHELL_NOTICE_REASON_VOCABULARY,
);

export function isTerminalShellNoticeReason(value: unknown): value is TerminalShellNoticeReason {
  return (
    typeof value === 'string' &&
    TERMINAL_SHELL_NOTICE_REASONS.has(value as TerminalShellNoticeReason)
  );
}

const TERMINAL_SUPPORT_FILE_NOTICE_REASON_VOCABULARY = [
  'containment-refused',
  'write-failed',
] as const;

export type TerminalSupportFileNoticeReason =
  (typeof TERMINAL_SUPPORT_FILE_NOTICE_REASON_VOCABULARY)[number];

export const TERMINAL_SUPPORT_FILE_NOTICE_REASONS: ReadonlySet<TerminalSupportFileNoticeReason> =
  new Set(TERMINAL_SUPPORT_FILE_NOTICE_REASON_VOCABULARY);

export function isTerminalSupportFileNoticeReason(
  value: unknown,
): value is TerminalSupportFileNoticeReason {
  return (
    typeof value === 'string' &&
    TERMINAL_SUPPORT_FILE_NOTICE_REASONS.has(value as TerminalSupportFileNoticeReason)
  );
}

export interface CopyImageRequest {
  readonly src: string;
}

export type CopyImageFailureReason =
  | 'fetch-failed'
  | 'path-escape'
  | 'empty-image'
  | 'read-error'
  | 'write-error';

export type CopyImageResult =
  | { ok: true }
  | { ok: false; reason: CopyImageFailureReason; detail?: string };
