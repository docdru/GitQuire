export interface PendingCreateSource {
  kind: 'file' | 'folder';
  renamePath: string;
  createdPath: string;
}

export function createdRenameSource(
  pending: PendingCreateSource | null,
  sourceTreePath: string,
  isFolder: boolean,
): string | undefined {
  if (pending === null || pending.renamePath !== sourceTreePath) return undefined;
  if (pending.kind !== (isFolder ? 'folder' : 'file')) return undefined;
  return pending.createdPath;
}

export function withTreeExtension(docName: string, treePath: string): string {
  const leaf = treePath.slice(treePath.lastIndexOf('/') + 1);
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? `${docName}${leaf.slice(dot)}` : docName;
}
