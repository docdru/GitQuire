import { useLingui } from '@lingui/react/macro';
import type { DraftStatus } from '@/lib/gitquire/drafts-api';
import { cn } from '@/lib/utils';

export function StatusPill({ status, className }: { status: DraftStatus; className?: string }) {
  const { t } = useLingui();
  const label =
    status === 'draft'
      ? t`Draft`
      : status === 'review'
        ? t`Ready for review`
        : status === 'published'
          ? t`Published`
          : t`Discarded`;
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-px text-[0.7rem] font-medium leading-4',
        status === 'draft' && 'bg-warning/20 text-foreground',
        status === 'review' && 'bg-info/20 text-foreground',
        status === 'published' && 'bg-success/20 text-foreground',
        status === 'discarded' && 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {label}
    </span>
  );
}
