import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import { docNameToRelativePath, joinWorkspacePath, type Workspace } from './workspace-paths';

export function resolveActiveTargetAbsPath(
  activeTarget: ResolvedNavigationTarget | null,
  workspace: Workspace,
): string {
  if (activeTarget?.kind === 'doc') {
    return joinWorkspacePath(
      workspace.contentDir,
      docNameToRelativePath(activeTarget.docName),
      workspace.pathSeparator,
    );
  }
  if (activeTarget?.kind === 'folder-index') {
    return joinWorkspacePath(
      workspace.contentDir,
      docNameToRelativePath(activeTarget.docName),
      workspace.pathSeparator,
    );
  }
  if (activeTarget?.kind === 'folder') {
    return joinWorkspacePath(
      workspace.contentDir,
      activeTarget.folderPath,
      workspace.pathSeparator,
    );
  }
  if (activeTarget?.kind === 'asset') {
    return joinWorkspacePath(workspace.contentDir, activeTarget.assetPath, workspace.pathSeparator);
  }
  return workspace.contentDir;
}

export function resolveActiveTargetRelativePath(
  activeTarget: ResolvedNavigationTarget | null,
): string {
  if (activeTarget?.kind === 'doc' || activeTarget?.kind === 'folder-index') {
    return docNameToRelativePath(activeTarget.docName);
  }
  if (activeTarget?.kind === 'folder') {
    return activeTarget.folderPath;
  }
  if (activeTarget?.kind === 'asset') {
    return activeTarget.assetPath;
  }
  return '';
}
