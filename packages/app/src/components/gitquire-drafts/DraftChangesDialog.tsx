import { useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { hashFromDocName } from '@/lib/doc-hash';
import {
  collapseUnchanged,
  type DiffBlock,
  diffBlocks,
  docNameOfPath,
} from '@/lib/gitquire/draft-diff';
import { type DraftSummary, fetchDraftChanges, type PageChange } from '@/lib/gitquire/drafts-api';
import { cn } from '@/lib/utils';
import { failureCopy } from './draft-actions';
import { closeDraftDialog } from './draft-dialogs-store';

export function DraftChangesDialog({ draft }: { draft: DraftSummary }) {
  const { t } = useLingui();
  const [pages, setPages] = useState<PageChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    fetchDraftChanges(draft.slug).then(
      (result) => {
        if (!stale) setPages(result);
      },
      (failure: unknown) => {
        if (!stale) setError(failureCopy(failure));
      },
    );
    return () => {
      stale = true;
    };
  }, [draft.slug]);

  return (
    <Dialog open onOpenChange={(open) => !open && closeDraftDialog()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t`Changes in "${draft.title}"`}</DialogTitle>
          <DialogDescription>
            {t`What this draft changes compared with the live wiki. Added words are green, removed words are red.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[70vh] space-y-3 overflow-y-auto">
          {error !== null ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : pages === null ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : pages.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t`Nothing has changed in this draft yet.`}</p>
          ) : (
            pages.map((page) => (
              <PageDiff key={page.path} page={page} defaultOpen={pages.length <= 5} />
            ))
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function PageDiff({ page, defaultOpen }: { page: PageChange; defaultOpen: boolean }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(defaultOpen);
  const label =
    page.change === 'added' ? t`New page` : page.change === 'deleted' ? t`Deleted` : t`Changed`;
  const docName = docNameOfPath(page.path);
  return (
    <section className="rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto min-w-0 flex-1 justify-start gap-2 px-1 text-start"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDown aria-hidden="true" className="size-4" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-4" />
          )}
          <span className="truncate font-medium">{docName}</span>
          <span
            className={cn(
              'shrink-0 rounded px-1.5 text-xs',
              page.change === 'added' && 'bg-success/20 text-foreground',
              page.change === 'deleted' && 'bg-destructive/15 text-foreground',
              page.change === 'modified' && 'bg-warning/20 text-foreground',
            )}
          >
            {label}
          </span>
        </Button>
        {page.change !== 'deleted' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              closeDraftDialog();
              window.location.assign(hashFromDocName(docName));
            }}
          >
            <ExternalLink aria-hidden="true" />
            {t`Open`}
          </Button>
        ) : null}
      </div>
      {open ? <DiffBody before={page.before ?? ''} after={page.after ?? ''} /> : null}
    </section>
  );
}

function DiffBody({ before, after }: { before: string; after: string }) {
  const { t } = useLingui();
  const blocks = collapseUnchanged(diffBlocks(before, after));
  return (
    <div className="space-y-2 border-t px-4 py-3 font-serif text-[0.95rem] leading-relaxed">
      {blocks.map((block) =>
        'gap' in block ? (
          <p key={block.key} className="text-center font-sans text-xs text-muted-foreground">
            {block.gap === 1 ? t`1 unchanged paragraph` : t`${block.gap} unchanged paragraphs`}
          </p>
        ) : (
          <Paragraph key={block.key} block={block} />
        ),
      )}
    </div>
  );
}

function Paragraph({ block }: { block: DiffBlock }) {
  return (
    <p className={cn('whitespace-pre-wrap break-words', !block.changed && 'text-muted-foreground')}>
      {block.segments.map((segment) =>
        segment.kind === 'same' ? (
          <span key={segment.key}>{segment.text}</span>
        ) : segment.kind === 'added' ? (
          <ins key={segment.key} className="rounded-sm bg-success/20 text-foreground no-underline">
            {segment.text}
          </ins>
        ) : (
          <del
            key={segment.key}
            className="rounded-sm bg-destructive/15 text-foreground decoration-destructive"
          >
            {segment.text}
          </del>
        ),
      )}
    </p>
  );
}
