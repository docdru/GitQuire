import { useLingui } from '@lingui/react/macro';
import { ChevronDown, FilePen, Globe, History, LayoutList, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { pathMatchesDoc } from '@/lib/gitquire/draft-diff';
import { type DraftSummary, isOpenDraft } from '@/lib/gitquire/drafts-api';
import { refreshDrafts, useDraftState } from '@/lib/gitquire/drafts-store';
import { useCurrentDocName } from '@/lib/gitquire/use-current-doc';
import { cn } from '@/lib/utils';
import { switchView } from './draft-actions';
import { openDraftDialog } from './draft-dialogs-store';
import { StatusPill } from './StatusPill';

const LIVE = '__live__';

export function DraftMenu() {
  const { t } = useLingui();
  const { list, current } = useDraftState();
  const docName = useCurrentDocName();
  if (list === null || !list.enabled) return null;

  const viewing = current?.viewing ?? null;
  const open = list.drafts.filter(isOpenDraft);
  const forPage =
    viewing === null
      ? open.filter((draft) => draft.pages.some((page) => pathMatchesDoc(page.path, docName)))
      : [];
  const pageName = docName === null ? null : docName.slice(docName.lastIndexOf('/') + 1);
  const pagePath = docName === null ? null : `${docName}.md`;

  const choose = (value: string) => {
    const slug = value === LIVE ? null : value;
    if (slug === (viewing?.slug ?? null)) return;
    void switchView(slug);
  };

  return (
    <DropdownMenu onOpenChange={(isOpen) => isOpen && void refreshDrafts()}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'min-w-0 gap-1.5',
            viewing === null
              ? 'text-muted-foreground'
              : 'bg-warning/15 text-foreground hover:bg-warning/25',
          )}
          data-testid="gitquire-draft-menu"
        >
          {viewing === null ? <Globe aria-hidden="true" /> : <FilePen aria-hidden="true" />}
          <span className="max-w-44 truncate">
            {viewing === null ? t`Live wiki` : t`Draft: ${viewing.title}`}
          </span>
          {forPage.length > 0 ? (
            <span
              className="rounded-full bg-warning px-1.5 text-[0.65rem] font-semibold leading-4 text-background"
              title={t`This page has changes in a draft`}
            >
              {forPage.length}
            </span>
          ) : null}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-h-[28rem] min-w-72 overflow-y-auto">
        <DropdownMenuLabel>{t`What you are looking at`}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={viewing?.slug ?? LIVE} onValueChange={choose}>
          <DropdownMenuRadioItem value={LIVE}>
            <span className="truncate">{t`Live wiki`}</span>
          </DropdownMenuRadioItem>
          {open.map((draft) => (
            <DraftRadioItem key={draft.slug} draft={draft} highlight={forPage.includes(draft)} />
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openDraftDialog({ kind: 'new', title: '' })}>
          <Plus aria-hidden="true" />
          {t`New draft…`}
        </DropdownMenuItem>
        {viewing === null && pageName !== null && pagePath !== null ? (
          <>
            <DropdownMenuItem
              onSelect={() => openDraftDialog({ kind: 'new', title: t`Changes to ${pageName}` })}
            >
              <FilePen aria-hidden="true" />
              <span className="truncate">{t`Propose changes to this page…`}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                openDraftDialog({ kind: 'move', path: pagePath, title: t`Changes to ${pageName}` })
              }
            >
              <History aria-hidden="true" />
              <span className="truncate">{t`Move my recent edits to a draft…`}</span>
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => openDraftDialog({ kind: 'overview' })}>
          <LayoutList aria-hidden="true" />
          {t`All drafts…`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DraftRadioItem({ draft, highlight }: { draft: DraftSummary; highlight: boolean }) {
  const { t } = useLingui();
  return (
    <DropdownMenuRadioItem value={draft.slug} className="items-start">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate">{draft.title}</span>
          <StatusPill status={draft.status} />
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {draft.agent
            ? t`Claude, for ${draft.author.name ?? draft.author.login}`
            : (draft.author.name ?? draft.author.login)}
          {highlight ? ` · ${t`changes this page`}` : ''}
        </span>
      </span>
    </DropdownMenuRadioItem>
  );
}
