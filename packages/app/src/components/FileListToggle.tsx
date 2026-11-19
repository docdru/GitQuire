import { useLingui } from '@lingui/react/macro';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { physicalSide } from '@/lib/sidebar-side-store';
import { useDocumentDirection } from '@/lib/use-document-direction';
import { cn } from '@/lib/utils';

export function FileListToggle({ side = 'start' }: { readonly side?: 'start' | 'end' }) {
  const { t } = useLingui();
  const direction = useDocumentDirection();
  const { state } = useSidebar();

  return (
    <div
      data-file-list-toggle=""
      className={cn(
        'flex h-full shrink-0 items-center gap-1',
        side === 'start' ? 'pe-1' : 'flex-row-reverse ps-1',
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarTrigger
            side={physicalSide(side, direction)}
            className={cn('shrink-0 text-muted-foreground')}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span>{state === 'expanded' ? t`Hide Files` : t`Show Files`}</span>{' '}
          <Kbd aria-label={formatShortcutLabel('toggle-files-sidebar')}>
            {formatShortcut('toggle-files-sidebar')}
          </Kbd>
        </TooltipContent>
      </Tooltip>
      <Separator orientation="vertical" className="h-4 shrink-0 data-vertical:self-center" />
    </div>
  );
}
