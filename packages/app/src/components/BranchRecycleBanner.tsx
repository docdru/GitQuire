import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useDocumentContext } from '@/editor/DocumentContext';
import { BRANCH_SWITCH_NOTICE_MS, computeRecycleBannerMode } from '@/lib/branch-recycle-notice';

export function BranchRecycleBanner() {
  const { contentRecycleNotice, dismissContentRecycleNotice } = useDocumentContext();
  const [switchExpired, setSwitchExpired] = useState(false);

  useEffect(() => {
    setSwitchExpired(false);
    if (contentRecycleNotice?.kind !== 'branch-switch') return;
    const remaining = Math.max(0, contentRecycleNotice.at + BRANCH_SWITCH_NOTICE_MS - Date.now());
    const timer = setTimeout(() => setSwitchExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [contentRecycleNotice]);

  const mode = computeRecycleBannerMode(contentRecycleNotice, switchExpired);
  if (mode === 'hidden') return null;

  if (mode === 'switch') {
    const branch =
      contentRecycleNotice?.kind === 'branch-switch' ? contentRecycleNotice.branch : '';
    return (
      <div
        role="status"
        data-testid="branch-recycle-banner-switch"
        className="fixed top-[var(--ok-app-header-height,0px)] inset-x-0 z-50 bg-warning text-background text-sm text-center py-2 px-4 ps-[var(--ok-titlebar-reserve-left,1rem)] shadow-md"
      >
        <Trans>
          Server switched to branch <code className="bg-background/20 px-1 rounded">{branch}</code>{' '}
          — reloading content
        </Trans>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="branch-recycle-banner-refused"
      className="fixed top-[var(--ok-app-header-height,0px)] inset-x-0 z-50 bg-destructive text-background text-sm text-center py-2 px-4 ps-[var(--ok-titlebar-reserve-left,1rem)] shadow-md flex items-center justify-center gap-3 flex-wrap"
    >
      <span>
        <Trans>
          The project's server is on a different branch than this window — content can't load.
        </Trans>
      </span>
      <Button
        size="sm"
        onClick={() => window.location.reload()}
        className="h-6 bg-background text-foreground px-2 text-xs font-medium hover:bg-background/90"
      >
        <Trans>Reload</Trans>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={dismissContentRecycleNotice}
        aria-label={t`Dismiss`}
        className="h-6 px-2 text-xs text-background hover:bg-background/20"
      >
        <Trans>Dismiss</Trans>
      </Button>
    </div>
  );
}
