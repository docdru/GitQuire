import { resolveFileTreeSelectionAction } from '@/components/file-tree-selection';
import type { FileEntry } from '@/components/file-tree-utils';
import { isDocumentEntry } from '@/components/file-tree-utils';
import type { SidebarDragPayload } from '@/lib/sidebar-drag';

export function sidebarDragPayloadForTreePath(
  treePath: string,
  entries: readonly FileEntry[],
  pageMeta?: ReadonlyMap<string, { size?: number | null }>,
): SidebarDragPayload | null {
  const action = resolveFileTreeSelectionAction(treePath, entries);
  if (action.kind === 'none') return null;
  if (action.kind === 'asset') {
    return { v: 1, kind: 'asset', assetPath: action.path, mediaKind: action.mediaKind };
  }
  if (action.kind === 'folder') {
    return { v: 1, kind: 'folder', folderPath: action.path };
  }
  const entry = entries.find((item) => isDocumentEntry(item) && item.docName === action.path);
  return {
    v: 1,
    kind: 'doc',
    docName: action.path,
    size: entry?.size ?? pageMeta?.get(action.path)?.size ?? null,
  };
}
