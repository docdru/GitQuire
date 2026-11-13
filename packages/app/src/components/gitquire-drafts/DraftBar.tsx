import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  Check,
  FileDiff,
  Globe,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Rocket,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import {
  type DraftSummary,
  markDraft,
  openView,
  reviewState,
  updateDraft,
} from '@/lib/gitquire/drafts-api';
import {
  onDraftClosed,
  refreshDrafts,
  reloadIntoView,
  useDraftState,
} from '@/lib/gitquire/drafts-store';
import { DraftDialogs } from './DraftDialogs';
import { failureCopy, switchView } from './draft-actions';
import { openDraftDialog } from './draft-dialogs-store';
import { StatusPill } from './StatusPill';

export function DraftBar() {
  const { t } = useLingui();
  const { list, current } = useDraftState();
  const viewing = current?.viewing ?? null;
  const drift = current?.drift ?? null;

  useEffect(
    () =>
      onDraftClosed((closed) => {
        const who = closed.closedBy?.name ?? closed.closedBy?.login;
        const message =
          closed.status === 'published'
            ? who === undefined
              ? t`"${closed.title}" was published. You are back on the live wiki.`
              : t`${who} published "${closed.title}". You are back on the live wiki.`
            : t`"${closed.title}" was discarded. You are back on the live wiki.`;
        toast.info(message, { duration: 6000 });
        void openView(null)
          .catch(() => undefined)
          .then(() => setTimeout(() => reloadIntoView(), 1500));
      }),
    [t],
  );

  useEffect(() => {
    const root = document.documentElement;
    if (viewing === null) root.removeAttribute('data-gitquire-draft');
    else root.setAttribute('data-gitquire-draft', viewing.status);
    return () => root.removeAttribute('data-gitquire-draft');
  }, [viewing]);

  if (list === null || !list.enabled) return null;
  return (
    <>
      {viewing === null ? null : (
        <>
          <div
            aria-hidden="true"
            data-testid="gitquire-draft-frame"
            className="pointer-events-none fixed inset-0 z-40 border-[3px] border-warning/80"
          />
          <DraftBarContent
            draft={viewing}
            me={list.me}
            behind={drift?.behind ?? 0}
            livePages={drift?.pages ?? []}
          />
        </>
      )}
      <DraftDialogs />
    </>
  );
}

function DraftBarContent({
  draft,
  me,
  behind,
  livePages,
}: {
  draft: DraftSummary;
  me: string;
  behind: number;
  livePages: string[];
}) {
  const { t } = useLingui();
  const [updating, setUpdating] = useState(false);
  const mine = draft.author.login.toLowerCase() === me.toLowerCase();
  const verdict = reviewState(draft);
  const myReview = draft.reviews.find((review) => review.login.toLowerCase() === me.toLowerCase());

  async function update() {
    setUpdating(true);
    const result = await updateDraft(draft.slug).catch((failure: unknown) => {
      toast.error(t`Couldn't update the draft.`, { description: failureCopy(failure) });
      return null;
    });
    setUpdating(false);
    if (result === null) return;
    if (result.kind === 'conflicts') {
      openDraftDialog({ kind: 'conflicts', draft, files: result.files });
      return;
    }
    toast.success(
      result.kind === 'updated'
        ? t`The draft now includes the latest live wiki.`
        : t`The draft was already up to date.`,
    );
    reloadIntoView();
  }

  async function backToDraft() {
    try {
      await markDraft(draft.slug);
      await refreshDrafts();
    } catch (failure) {
      toast.error(t`Couldn't change the status.`, { description: failureCopy(failure) });
    }
  }

  const pages = draft.pages.length;
  return (
    <section
      aria-label={t`Draft`}
      data-testid="gitquire-draft-bar"
      className="fixed inset-x-2 bottom-3 z-50 mx-auto flex max-w-4xl flex-col gap-2 rounded-xl border border-warning/60 bg-background/95 p-2 shadow-lg backdrop-blur sm:inset-x-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 ps-1">
          <StatusPill status={draft.status} />
          <span className="min-w-24 truncate text-sm font-medium" title={draft.title}>
            {draft.title}
          </span>
          <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline">
            {pages === 0 ? t`No changes yet · not live` : t`${pages} changed · not live yet`}
          </span>
          {verdict === 'approved' ? (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check aria-hidden="true" className="size-3.5" />
              {t`Approved`}
            </span>
          ) : verdict === 'changes' ? (
            <span className="text-xs text-destructive">{t`Changes requested`}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openDraftDialog({ kind: 'changes', draft })}
          >
            <FileDiff aria-hidden="true" />
            {t`Changes`}
          </Button>
          {draft.status === 'draft' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openDraftDialog({ kind: 'ready', draft })}
            >
              <Send aria-hidden="true" />
              {t`Ready for review`}
            </Button>
          ) : !mine && myReview === undefined ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openDraftDialog({ kind: 'review', draft, verdict: 'approved' })}
              >
                <Check aria-hidden="true" />
                {t`Approve`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openDraftDialog({ kind: 'review', draft, verdict: 'changes' })}
              >
                {t`Ask for changes`}
              </Button>
            </>
          ) : null}
          <Button size="sm" onClick={() => openDraftDialog({ kind: 'publish', draft })}>
            <Rocket aria-hidden="true" />
            {t`Publish`}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={t`More draft actions`}>
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => openDraftDialog({ kind: 'rename', draft })}>
                <Pencil aria-hidden="true" />
                {t`Rename…`}
              </DropdownMenuItem>
              {draft.status === 'review' ? (
                <DropdownMenuItem onSelect={() => void backToDraft()}>
                  <Undo2 aria-hidden="true" />
                  {t`Back to draft`}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => void update()}>
                <RefreshCw aria-hidden="true" />
                {t`Update with the live wiki`}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openDraftDialog({ kind: 'overview' })}>
                {t`All drafts…`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => openDraftDialog({ kind: 'discard', draft })}
              >
                <Trash2 aria-hidden="true" />
                {t`Discard draft…`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void switchView(null)}
            title={t`Back to the live wiki`}
          >
            <Globe aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">{t`Live wiki`}</span>
            <X aria-hidden="true" className="sm:hidden" />
          </Button>
        </div>
      </div>
      {behind > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-info/15 px-2 py-1 text-xs text-foreground">
          <span className="min-w-0 flex-1">
            {livePages.length === 0
              ? t`The live wiki changed since this draft started.`
              : plural(livePages.length, {
                  one: 'The live wiki changed since this draft started (# page updated).',
                  other: 'The live wiki changed since this draft started (# pages updated).',
                })}
          </span>
          <Button size="sm" variant="outline" disabled={updating} onClick={() => void update()}>
            {updating ? <Spinner aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {updating ? t`Updating…` : t`Update draft`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
