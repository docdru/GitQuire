import type { LintPluginId } from './markdown/lint/types.ts';

export type { RecentProjectEntry } from './sharing/index.ts';

export interface GqMenuActionOrigin {
  readonly launcherBorne: boolean;
}

export type GqMenuAction =
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
  | 'toggle-agent-panel'
  | 'toggle-editor'
  | 'new-worktree'
  | 'switch-worktree'
  | 'send-feedback';

export type GqCheckTargetExistsResult = 'exists' | 'missing' | 'unreadable';

export interface GqHeadBranchInfo {
  readonly currentBranch: string | null;
  readonly headSha: string | null;
  readonly detached: boolean;
}

export interface GqUpdateRelaunchFailedInfo {
  readonly version: string;
  readonly message?: string;
  readonly downloadUrl?: string;
  readonly dismissPending?: boolean;
  readonly reason?: 'no-longer-pending';
}

export type ShareTarget =
  | { readonly kind: 'doc'; readonly docPath: string }
  | { readonly kind: 'folder'; readonly folderPath: string };

export interface GqScaffoldFileEntry {
  path: string;
  kind: 'folder' | 'file';
  contentPreview?: string;
}

export interface GqScaffoldSkipEntry {
  path: string;
  reason: 'already-exists' | 'user-content' | 'glob-collision';
}

export interface GqScaffoldPlan {
  created: GqScaffoldFileEntry[];
  skipped: GqScaffoldSkipEntry[];
  warnings: string[];
  requiredPlugins?: { id: LintPluginId; pending: boolean }[];
}

export interface GqScaffoldApplyError {
  path: string;
  error: string;
}

export interface GqScaffoldApplyResult {
  applied: number;
  errors: GqScaffoldApplyError[];
  durationMs: number;
  pluginsEnabled: LintPluginId[];
}

export interface GqSeedError {
  kind: 'no-project' | 'prerequisite-missing' | 'invalid-root' | 'internal';
  message: string;
}

export type GqPackId =
  | 'knowledge-base'
  | 'software-lifecycle'
  | 'codebase-wiki'
  | 'plain-notes'
  | 'worldbuilding'
  | 'writing-pipeline'
  | 'entity-vault'
  | 'okf';

export interface GqSeedPackFolderInfo {
  path: string;
  summary: string;
}

export interface GqSeedPackEntryCounts {
  files: number;
  folders: number;
}

export interface GqSeedPackInfo {
  id: GqPackId;
  name: string;
  description: string;
  defaultSubfolder?: string;
  folders: GqSeedPackFolderInfo[];
  entryCounts: GqSeedPackEntryCounts;
}

export type GqSeedPlanResult =
  | { ok: true; plan: GqScaffoldPlan }
  | { ok: false; error: GqSeedError };

export type GqSeedApplyResult =
  | { ok: true; result: GqScaffoldApplyResult }
  | { ok: false; error: GqSeedError };

export type GqSeedListPacksResult =
  | { ok: true; packs: GqSeedPackInfo[] }
  | { ok: false; error: { kind: 'internal'; message: string } };

export type GqLocalOpAuthSignoutResponse = { ok: true } | { ok: false; error?: string };

export type GqLocalOpAuthEvent =
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

export type GqLocalOpCloneEvent =
  | { type: 'progress'; phase: string; pct: number }
  | { type: 'complete'; dir: string }
  | { type: 'branch-fallback'; branch: string }
  | {
      type: 'error';
      message: string;
      code?: 'unsafe-symlinks';
      refusedSymlinkPaths?: string[];
    };

export type GqLocalOpAuthStatusResponse =
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

export interface GqLocalOpRepoEntry {
  full_name: string;
  clone_url: string;
  private: boolean;
}

export type GqLocalOpAuthReposResponse =
  | { ok: true; host: string; repos: GqLocalOpRepoEntry[] }
  | { ok: false; error: string; authenticated?: false };

export interface GqEditorViewMenuStateSnapshot {
  readonly showHiddenFiles: boolean;
  readonly showOkFolders: boolean;
  readonly showOnlyMarkdownFiles: boolean;
  readonly canExpandAll: boolean;
  readonly canCollapseAll: boolean;
  readonly sidebarVisible: boolean;
  readonly docPanelVisible?: boolean;
  readonly agentPanelVisible?: boolean;
  readonly editorVisible?: boolean;
  readonly canViewInSource?: boolean;
  readonly hasEditorSelection?: boolean;
}

export interface GqEditorWideVisibility {
  readonly editorVisible?: boolean;
  readonly agentPanelVisible?: boolean;
}

type GqEditorDockVisibilityKey = keyof GqEditorWideVisibility;

type GqEditorOnlyPane<K extends GqEditorDockVisibilityKey> = { readonly [P in K]: boolean } & {
  readonly [P in Exclude<GqEditorDockVisibilityKey, K>]?: never;
};

type GqEditorDockVisibilityChange = {
  [K in GqEditorDockVisibilityKey]: GqEditorOnlyPane<K> & {
    readonly wideIntent: GqEditorOnlyPane<K>;
  };
}[GqEditorDockVisibilityKey];

export type GqEditorViewMenuStateChange = Partial<
  Omit<GqEditorViewMenuStateSnapshot, GqEditorDockVisibilityKey>
> &
  (
    | GqEditorDockVisibilityChange
    | ({ readonly [K in GqEditorDockVisibilityKey]?: never } & { readonly wideIntent?: never })
  );

export type GqAssetOpenRefusalReason =
  | 'extension-blocked'
  | 'not-a-file'
  | 'path-escape'
  | 'not-found'
  | 'resolve-error';

export function assetOpenRefusalRevealsInstead(reason: GqAssetOpenRefusalReason): boolean {
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
