import { useLingui } from '@lingui/react/macro';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { extractMentions } from '@/gitquire-comments/thread-ops';
import { GitQuireApiError } from '@/lib/gitquire/branch-api';
import {
  createDraft,
  type DraftSummary,
  discardDraft,
  markReady,
  moveRecentEdits,
  publishDraft,
  renameDraft,
  reviewDraft,
  updateDraft,
} from '@/lib/gitquire/drafts-api';
import { refreshDrafts, reloadIntoView } from '@/lib/gitquire/drafts-store';
import { DraftChangesDialog } from './DraftChangesDialog';
import { DraftConflictsDialog } from './DraftConflictsDialog';
import { DraftsOverviewDialog } from './DraftsOverviewDialog';
import { failureCopy, pageLabel } from './draft-actions';
import {
  closeDraftDialog,
  type DraftDialog,
  openDraftDialog,
  useDraftDialog,
} from './draft-dialogs-store';

export function DraftDialogs() {
  const dialog = useDraftDialog();
  if (dialog === null) return null;
  return <DialogFor key={dialogKey(dialog)} dialog={dialog} />;
}

function dialogKey(dialog: DraftDialog): string {
  return 'draft' in dialog ? `${dialog.kind}:${dialog.draft.slug}` : dialog.kind;
}

function DialogFor({ dialog }: { dialog: DraftDialog }) {
  switch (dialog.kind) {
    case 'new':
      return <NameDialog mode="new" initial={dialog.title} />;
    case 'move':
      return <NameDialog mode="move" initial={dialog.title} path={dialog.path} />;
    case 'rename':
      return <NameDialog mode="rename" initial={dialog.draft.title} draft={dialog.draft} />;
    case 'ready':
      return <ReadyDialog draft={dialog.draft} />;
    case 'review':
      return <ReviewDialog draft={dialog.draft} verdict={dialog.verdict} />;
    case 'publish':
      return <PublishDialog draft={dialog.draft} />;
    case 'discard':
      return <DiscardDialog draft={dialog.draft} />;
    case 'changes':
      return <DraftChangesDialog draft={dialog.draft} />;
    case 'conflicts':
      return <DraftConflictsDialog draft={dialog.draft} files={dialog.files} />;
    case 'overview':
      return <DraftsOverviewDialog />;
  }
}

function onOpenChange(open: boolean): void {
  if (!open) closeDraftDialog();
}

function NameDialog({
  mode,
  initial,
  path,
  draft,
}: {
  mode: 'new' | 'move' | 'rename';
  initial: string;
  path?: string;
  draft?: DraftSummary;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const [title, setTitle] = useState(initial);
  const [busy, setBusy] = useState(false);
  const trimmed = title.trim();

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (trimmed === '' || busy) return;
    setBusy(true);
    try {
      if (mode === 'rename' && draft !== undefined) {
        await renameDraft(draft.slug, trimmed);
        await refreshDrafts();
        closeDraftDialog();
        return;
      }
      if (mode === 'move' && path !== undefined) {
        await moveRecentEdits(path, trimmed);
        toast.success(t`Your recent edits are now in the draft "${trimmed}".`);
      } else {
        await createDraft(trimmed);
      }
      closeDraftDialog();
      reloadIntoView();
    } catch (failure) {
      toast.error(t`Couldn't save the draft.`, { description: failureCopy(failure) });
      setBusy(false);
    }
  }

  const heading =
    mode === 'new'
      ? t`New draft`
      : mode === 'move'
        ? t`Move my recent edits into a draft`
        : t`Rename draft`;
  const description =
    mode === 'new'
      ? t`A draft is your own copy of the wiki. Change anything; nothing goes live until someone publishes it. Others keep seeing the live wiki.`
      : mode === 'move'
        ? t`Your edits from the last hours on "${pageLabel(path ?? '')}" move into a new draft, and the live page goes back to how it was before.`
        : t`Give the draft a name that says what it changes.`;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{heading}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2">
            <Label htmlFor={inputId}>{t`Name`}</Label>
            <Input
              id={inputId}
              autoFocus
              maxLength={120}
              value={title}
              placeholder={t`e.g. Onboarding guide update`}
              onChange={(event) => setTitle(event.target.value)}
            />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDraftDialog}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={trimmed === '' || busy}>
              {busy
                ? t`Working…`
                : mode === 'rename'
                  ? t`Rename`
                  : mode === 'move'
                    ? t`Move into draft`
                    : t`Create and open`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReadyDialog({ draft }: { draft: DraftSummary }) {
  const { t } = useLingui();
  const peopleId = useId();
  const noteId = useId();
  const [people, setPeople] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const logins = extractMentions(people);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await markReady(draft.slug, logins, note);
      toast.success(
        logins.length === 0
          ? t`"${draft.title}" is ready for review.`
          : t`"${draft.title}" is ready for review. ${logins.map((login) => `@${login}`).join(', ')} will be notified.`,
      );
      await refreshDrafts();
      closeDraftDialog();
    } catch (failure) {
      toast.error(t`Couldn't mark the draft as ready.`, { description: failureCopy(failure) });
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t`Ready for review`}</DialogTitle>
            <DialogDescription>
              {t`Tell the team "${draft.title}" can be checked. Mention people to notify them in their inbox (and by email if they turned it on).`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={peopleId}>{t`Who should review?`}</Label>
              <Input
                id={peopleId}
                autoFocus
                value={people}
                placeholder={t`@anna @ben`}
                onChange={(event) => setPeople(event.target.value)}
              />
              {logins.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t`Will notify: ${logins.map((login) => `@${login}`).join(', ')}`}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={noteId}>{t`Note (optional)`}</Label>
              <Textarea
                id={noteId}
                rows={3}
                maxLength={2000}
                value={note}
                placeholder={t`What should reviewers look at?`}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDraftDialog}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t`Working…` : t`Mark ready for review`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReviewDialog({
  draft,
  verdict,
}: {
  draft: DraftSummary;
  verdict: 'approved' | 'changes';
}) {
  const { t } = useLingui();
  const noteId = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    setBusy(true);
    try {
      await reviewDraft(draft.slug, verdict, note);
      await refreshDrafts();
      closeDraftDialog();
    } catch (failure) {
      toast.error(t`Couldn't save your review.`, { description: failureCopy(failure) });
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>
              {verdict === 'approved' ? t`Approve "${draft.title}"` : t`Ask for changes`}
            </DialogTitle>
            <DialogDescription>
              {verdict === 'approved'
                ? t`Let ${draft.author.name ?? draft.author.login} know the draft looks good.`
                : t`Say what should change. For a specific sentence, you can also leave a comment on the page.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-1.5">
            <Label htmlFor={noteId}>{t`Note`}</Label>
            <Textarea
              id={noteId}
              rows={3}
              maxLength={2000}
              value={note}
              autoFocus
              onChange={(event) => setNote(event.target.value)}
            />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDraftDialog}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={busy || (verdict === 'changes' && note.trim() === '')}>
              {verdict === 'approved' ? t`Approve` : t`Send`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PublishDialog({ draft }: { draft: DraftSummary }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const pages = draft.pages.length;
  const unreviewed = draft.status === 'draft' || draft.reviews.length === 0;

  async function publish() {
    setBusy(true);
    try {
      await publishDraft(draft.slug);
      closeDraftDialog();
      toast.success(t`"${draft.title}" is live.`);
      setTimeout(() => reloadIntoView(), 2500);
    } catch (failure) {
      setBusy(false);
      if (failure instanceof GitQuireApiError && failure.code === 'conflict') {
        try {
          const result = await updateDraft(draft.slug);
          if (result.kind === 'conflicts') {
            openDraftDialog({ kind: 'conflicts', draft, files: result.files });
            return;
          }
          await publishDraft(draft.slug);
          closeDraftDialog();
          toast.success(t`"${draft.title}" is live.`);
          setTimeout(() => reloadIntoView(), 2500);
        } catch (retryFailure) {
          toast.error(t`Couldn't publish the draft.`, { description: failureCopy(retryFailure) });
        }
        return;
      }
      toast.error(t`Couldn't publish the draft.`, { description: failureCopy(failure) });
    }
  }

  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Publish "${draft.title}"?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {pages === 1
              ? t`1 page goes live for everyone. The draft is closed afterwards.`
              : t`${pages} pages go live for everyone. The draft is closed afterwards.`}
            {unreviewed ? ` ${t`Nobody has reviewed it yet.`}` : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t`Cancel`}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void publish();
            }}
          >
            {busy ? t`Publishing…` : t`Publish`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DiscardDialog({ draft }: { draft: DraftSummary }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);

  async function discard() {
    setBusy(true);
    try {
      await discardDraft(draft.slug);
      closeDraftDialog();
      toast.success(t`"${draft.title}" was discarded.`);
      setTimeout(() => reloadIntoView(), 2500);
    } catch (failure) {
      setBusy(false);
      toast.error(t`Couldn't discard the draft.`, { description: failureCopy(failure) });
    }
  }

  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Discard "${draft.title}"?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`Its changes are thrown away for everyone. The live wiki stays as it is.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t`Cancel`}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              void discard();
            }}
          >
            {t`Discard`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
