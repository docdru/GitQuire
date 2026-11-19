import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { FORCE_SYNC_INTERVAL_MS } from '@/editor/provider-pool';
import { noteConnected, noteDisconnected, useDraftHandover } from '@/lib/gitquire/draft-handover';
import type { SyncStatus } from './use-sync-status';

const TOAST_ID = 'sync-status';

const DISCONNECT_PRESUMED_DEAD_MS = 10_000;
export const SYNC_CATCHUP_GRACE_MS = FORCE_SYNC_INTERVAL_MS + 3_000;

const NO_TOAST_HANDLERS = { onDismiss: undefined, onAutoClose: undefined };

type CatchupClaim = 'idle' | 'armed' | 'asserted' | 'dismissed';

export function useSyncToasts(status: SyncStatus, activeDocName: string | null) {
  const { t } = useLingui();
  const handover = useDraftHandover();
  const hasConnectedRef = useRef(false);
  const wasDisconnectedRef = useRef(false);
  const downgradeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downgradedRef = useRef(false);
  const outageEpisodeRef = useRef(false);
  const disconnectedSinceRef = useRef<number | null>(null);
  const catchupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catchupClaimRef = useRef<CatchupClaim>('idle');

  useEffect(
    () => () => {
      if (downgradeTimerRef.current !== null) {
        clearTimeout(downgradeTimerRef.current);
        downgradeTimerRef.current = null;
      }
      if (catchupTimerRef.current !== null) {
        clearTimeout(catchupTimerRef.current);
        catchupTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const clearDowngradeTimer = () => {
      if (downgradeTimerRef.current !== null) {
        clearTimeout(downgradeTimerRef.current);
        downgradeTimerRef.current = null;
      }
    };
    const clearCatchupTimer = () => {
      if (catchupTimerRef.current !== null) {
        clearTimeout(catchupTimerRef.current);
        catchupTimerRef.current = null;
      }
    };
    const endOutageEpisode = () => {
      outageEpisodeRef.current = false;
      catchupClaimRef.current = 'idle';
    };

    if (status === 'synced') {
      hasConnectedRef.current = true;
    }
    if (status === 'connected' || status === 'synced') noteConnected();

    const plannedStop =
      handover !== 'none' ||
      (status === 'disconnected' && hasConnectedRef.current && activeDocName !== null
        ? noteDisconnected()
        : false);
    if (plannedStop) {
      clearDowngradeTimer();
      clearCatchupTimer();
      if (outageEpisodeRef.current) toast.dismiss(TOAST_ID);
      endOutageEpisode();
      wasDisconnectedRef.current = false;
      downgradedRef.current = false;
      disconnectedSinceRef.current = null;
      return;
    }

    if (!activeDocName) {
      clearDowngradeTimer();
      clearCatchupTimer();
      if (catchupClaimRef.current === 'armed') {
        catchupClaimRef.current = 'idle';
      }
      return;
    }

    const showOutageToast = (message: string) => {
      outageEpisodeRef.current = true;
      toast.warning(message, {
        id: TOAST_ID,
        duration: Infinity,
        ...NO_TOAST_HANDLERS,
      });
    };
    const showConnectionLost = () =>
      showOutageToast(
        t`Connection lost — keep this tab open, your edits will sync when reconnected`,
      );
    const showServerStopped = () => showOutageToast(t`The server stopped.`);
    const showSyncCatchingUp = () => {
      catchupClaimRef.current = 'asserted';
      toast.warning(t`Sync is taking longer than usual — your changes are safe on this device.`, {
        id: TOAST_ID,
        duration: Infinity,
        ...NO_TOAST_HANDLERS,
        onDismiss: () => {
          catchupClaimRef.current = 'dismissed';
        },
      });
    };

    if (status === 'connected') {
      clearDowngradeTimer();
      downgradedRef.current = false;
      disconnectedSinceRef.current = null;
      if (outageEpisodeRef.current && catchupClaimRef.current === 'idle') {
        catchupClaimRef.current = 'armed';
        catchupTimerRef.current = setTimeout(() => {
          catchupTimerRef.current = null;
          if (outageEpisodeRef.current) {
            showSyncCatchingUp();
          } else {
            catchupClaimRef.current = 'idle';
          }
        }, SYNC_CATCHUP_GRACE_MS);
      }
    } else {
      clearCatchupTimer();
      if (catchupClaimRef.current !== 'dismissed') {
        catchupClaimRef.current = 'idle';
      }
    }

    if (status === 'disconnected' && hasConnectedRef.current) {
      wasDisconnectedRef.current = true;
      if (downgradedRef.current) {
        showServerStopped();
        return;
      }
      if (downgradeTimerRef.current === null) {
        const now = Date.now();
        if (disconnectedSinceRef.current === null) {
          disconnectedSinceRef.current = now;
        }
        const remainingMs = Math.min(
          DISCONNECT_PRESUMED_DEAD_MS,
          DISCONNECT_PRESUMED_DEAD_MS - (now - disconnectedSinceRef.current),
        );
        if (remainingMs <= 0) {
          downgradedRef.current = true;
          showServerStopped();
          return;
        }
        downgradeTimerRef.current = setTimeout(() => {
          downgradeTimerRef.current = null;
          downgradedRef.current = true;
          showServerStopped();
        }, remainingMs);
      }
      showConnectionLost();
    } else if (wasDisconnectedRef.current && status === 'synced') {
      wasDisconnectedRef.current = false;
      clearDowngradeTimer();
      downgradedRef.current = false;
      disconnectedSinceRef.current = null;
      endOutageEpisode();
      toast.success(t`Reconnected`, { id: TOAST_ID, duration: 3000, ...NO_TOAST_HANDLERS });
    }
  }, [status, activeDocName, t, handover]);
}
