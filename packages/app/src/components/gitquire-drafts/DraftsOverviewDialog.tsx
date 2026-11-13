import { formatRelativeAge } from '@inkeep/open-knowledge-core/utils/relative-time';
import { useLingui } from '@lingui/react/macro';
import { Check, ExternalLink, Plus } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { type DraftSummary, reviewState } from '@/lib/gitquire/drafts-api';
import { refreshDrafts, useDraftState } from '@/lib/gitquire/drafts-store';
import { cn } from '@/lib/utils';
import { switchView } from './draft-actions';
import { closeDraftDialog, openDraftDialog } from './draft-dialogs-store';

export function DraftsOverviewDialog() {
  const { t } = useLingui();
  const { list, current } = useDraftState();
  useEffect(() => {
    void refreshDrafts();
  }, []);
  const drafts = list?.drafts ?? [];
  const viewing = current?.viewing?.slug ?? null;
  const columns: Array<{ key: string; title: string; hint: string; items: DraftSummary[] }> = [
    {
      key: 'draft',
      title: t`Drafts`,
      hint: t`Being written`,
      items: drafts.filter((draft) => draft.status === 'draft'),
    },
    {
      key: 'review',
      title: t`Ready for review`,
      hint: t`Waiting for someone to check`,
      items: drafts.filter((draft) => draft.status === 'review'),
    },
    {
      key: 'closed',
      title: t`Recently closed`,
      hint: t`Published or discarded`,
      items: drafts
        .filter((draft) => draft.status === 'published' || draft.status === 'discarded')
        .slice(0, 15),
    },
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && closeDraftDialog()}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t`Drafts`}</DialogTitle>
          <DialogDescription>
            {t`Drafts are proposed changes that are not live yet. Open one to read or edit it; publish it to make it live for everyone.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[70vh] overflow-y-auto">
          <div className="grid gap-4 md:grid-cols-3">
            {columns.map((column) => (
              <section
                key={column.key}
                className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 p-2"
              >
                <header className="px-1">
                  <h3 className="text-sm font-semibold">
                    {column.title}{' '}
                    <span className="font-normal text-muted-foreground">{column.items.length}</span>
                  </h3>
                  <p className="text-xs text-muted-foreground">{column.hint}</p>
                </header>
                {column.items.length === 0 ? (
                  <p className="px-1 py-3 text-xs text-muted-foreground">{t`Nothing here.`}</p>
                ) : (
                  column.items.map((draft) => (
                    <DraftCard key={draft.slug} draft={draft} viewing={draft.slug === viewing} />
                  ))
                )}
                {column.key === 'draft' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="justify-start"
                    onClick={() => openDraftDialog({ kind: 'new', title: '' })}
                  >
                    <Plus aria-hidden="true" />
                    {t`New draft`}
                  </Button>
                ) : null}
              </section>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function DraftCard({ draft, viewing }: { draft: DraftSummary; viewing: boolean }) {
  const { t } = useLingui();
  const open = draft.status === 'draft' || draft.status === 'review';
  const verdict = reviewState(draft);
  const who = draft.agent
    ? t`Claude, for ${draft.author.name ?? draft.author.login}`
    : (draft.author.name ?? draft.author.login);
  const waitingFor = [...new Set(draft.requests.flatMap((request) => request.logins))]
    .map((login) => `@${login}`)
    .join(', ');
  const publisher = draft.closedBy?.name ?? draft.closedBy?.login;
  const approvers = draft.reviews
    .filter((review) => review.verdict === 'approved')
    .map((review) => review.name ?? review.login)
    .join(', ');
  return (
    <article
      className={cn(
        'flex flex-col gap-1.5 rounded-md border bg-background p-2.5 text-sm shadow-xs',
        viewing && 'border-warning',
      )}
    >
      <div className="font-medium leading-snug">{draft.title}</div>
      <div className="text-xs text-muted-foreground">
        {who} · {formatRelativeAge(open ? draft.updatedAt : (draft.closedAt ?? draft.updatedAt))}
      </div>
      {open ? (
        <div className="text-xs text-muted-foreground">
          {draft.pages.length === 1 ? t`1 page changed` : t`${draft.pages.length} pages changed`}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          {draft.status === 'published'
            ? publisher === undefined
              ? t`Published on GitHub`
              : t`Published by ${publisher}`
            : t`Discarded`}
        </div>
      )}
      {waitingFor !== '' && draft.status === 'review' ? (
        <div className="text-xs">{t`Asked: ${waitingFor}`}</div>
      ) : null}
      {verdict === 'approved' ? (
        <div className="flex items-center gap-1 text-xs text-success">
          <Check aria-hidden="true" className="size-3.5" />
          {t`Approved by ${approvers}`}
        </div>
      ) : verdict === 'changes' ? (
        <div className="text-xs text-destructive">{t`Changes requested`}</div>
      ) : null}
      <div className="flex flex-wrap gap-1 pt-1">
        {open ? (
          viewing ? (
            <span className="text-xs font-medium text-warning">{t`You are here`}</span>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void switchView(draft.slug)}>
              {t`Open`}
            </Button>
          )
        ) : null}
        {draft.pullUrl !== null ? (
          <Button size="sm" variant="ghost" asChild>
            <a href={draft.pullUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              {t`On GitHub`}
            </a>
          </Button>
        ) : null}
      </div>
    </article>
  );
}
