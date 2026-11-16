import type { SyncMode } from '@gitquire/core/config/auto-sync-mode';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';

export function engineSyncMode(status: Pick<GitSyncStatus, 'syncMode' | 'syncEnabled'>): SyncMode {
  if (status.syncMode !== undefined) return status.syncMode;
  return status.syncEnabled ? 'full' : 'off';
}
