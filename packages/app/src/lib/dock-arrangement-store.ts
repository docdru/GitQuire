import { readAgentsPanelWidth } from './agents-panel-width-store';
import {
  chatDockTree,
  DEFAULT_CHAT_SHARE,
  DOCK_EDGE_SHARE,
  type DockEdge,
  type DockNode,
  moveDockPaneToEdge,
  parseDockTree,
} from './dock-tree';
import type { PaneId } from './pane-visibility-store';
import { scopedStorageKey } from './storage-scope';

const DOCK_ARRANGEMENT_KEY = 'ok-dock-arrangement-v1';
const LEGACY_MIN_SHARE = 0.1;
const LEGACY_MAX_SHARE = 0.6;

export interface DockArrangement {
  readonly tree: DockNode;
}

export interface DockArrangementStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function dockArrangementStorageKey(contentDir: string | null): string {
  return scopedStorageKey(DOCK_ARRANGEMENT_KEY, contentDir);
}

function parseDockArrangement(value: unknown): DockArrangement | null {
  if (typeof value !== 'object' || value === null) return null;
  const tree = parseDockTree((value as Record<string, unknown>).tree);
  return tree === null ? null : { tree };
}

export function readDockArrangement(
  key: string,
  storage?: DockArrangementStorage,
): DockArrangement | null {
  let raw: string | null;
  try {
    raw = (storage ?? localStorage).getItem(key);
  } catch (err) {
    console.warn(`[dock-arrangement-store] reading ${key} failed: ${String(err)}`);
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[dock-arrangement-store] stored ${key} record was not valid JSON; ignoring it: ${String(err)}`,
    );
    return null;
  }
  const arrangement = parseDockArrangement(parsed);
  if (arrangement === null) {
    console.warn(
      `[dock-arrangement-store] stored ${key} record is not a dock arrangement; ignoring it`,
    );
  }
  return arrangement;
}

export function writeDockArrangement(
  key: string,
  arrangement: DockArrangement,
  storage?: DockArrangementStorage,
): void {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(arrangement));
  } catch (err) {
    console.warn(`[dock-arrangement-store] writing ${key} failed: ${String(err)}`);
  }
}

export interface LegacyDockStorage {
  getItem(key: string): string | null;
}

export interface DockWorkspaceExtent {
  readonly widthPx: number;
  readonly heightPx: number;
}

function legacyShare(px: number | null, total: number, fallback: number): number {
  if (px === null || !Number.isFinite(px) || !Number.isFinite(total) || total <= 0) {
    return fallback;
  }
  return Math.min(Math.max(px / total, LEGACY_MIN_SHARE), LEGACY_MAX_SHARE);
}

// precedent #59: seeded from the retired app-global layout keys, which nothing writes any more.
function seededDockArrangement(
  workspace: DockWorkspaceExtent,
  source: LegacyDockStorage,
): DockArrangement {
  const chatShare = legacyShare(
    readAgentsPanelWidth(source),
    workspace.widthPx,
    DEFAULT_CHAT_SHARE,
  );
  return { tree: chatDockTree(chatShare) };
}

function legacyStorage(storage: LegacyDockStorage | undefined): LegacyDockStorage {
  return {
    getItem(key) {
      try {
        return (storage ?? localStorage).getItem(key);
      } catch (err) {
        console.warn(`[dock-arrangement-store] reading ${key} failed: ${String(err)}`);
        return null;
      }
    },
  };
}

export function legacyDockArrangement(
  workspace: DockWorkspaceExtent,
  storage?: LegacyDockStorage,
): DockArrangement {
  return seededDockArrangement(workspace, legacyStorage(storage));
}

export function withDockTree(arrangement: DockArrangement, tree: DockNode): DockArrangement {
  return tree === arrangement.tree ? arrangement : { tree };
}

export function withDockPaneAtEdge(
  arrangement: DockArrangement,
  pane: PaneId,
  edge: DockEdge,
): DockArrangement {
  return withDockTree(
    arrangement,
    moveDockPaneToEdge(arrangement.tree, pane, edge, DOCK_EDGE_SHARE[pane]),
  );
}
