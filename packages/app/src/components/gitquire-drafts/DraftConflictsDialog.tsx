import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
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
import { Textarea } from '@/components/ui/textarea';
import { docNameOfPath } from '@/lib/gitquire/draft-diff';
import {
  type ConflictChunk,
  type DraftSummary,
  type FileConflict,
  resolveConflict,
  updateDraft,
} from '@/lib/gitquire/drafts-api';
import { reloadIntoView } from '@/lib/gitquire/drafts-store';
import { cn } from '@/lib/utils';
import { failureCopy } from './draft-actions';
import { closeDraftDialog, openDraftDialog } from './draft-dialogs-store';

type Choice = 'live' | 'draft' | 'both' | 'own';

interface Spot {
  id: string;
  path: string;
  index: number;
  chunk: ConflictChunk;
  before: string;
}

function spotsOf(files: readonly FileConflict[]): Spot[] {
  const spots: Spot[] = [];
  for (const file of files) {
    let index = 0;
    let before = '';
    for (const chunk of file.chunks) {
      if (chunk.kind === 'same') {
        before = chunk.text ?? '';
        continue;
      }
      spots.push({ id: `${file.path}#${index}`, path: file.path, index, chunk, before });
      index += 1;
    }
  }
  return spots;
}

function textFor(chunk: ConflictChunk, choice: Choice, own: string | undefined): string {
  const live = chunk.live ?? '';
  const draft = chunk.draft ?? '';
  if (choice === 'live') return live;
  if (choice === 'draft') return draft;
  if (choice === 'both')
    return `${draft}${draft.endsWith('\n') || draft === '' ? '' : '\n'}${live}`;
  return own ?? draft;
}

function lastLines(text: string, count = 2): string {
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

export function DraftConflictsDialog({
  draft,
  files,
}: {
  draft: DraftSummary;
  files: FileConflict[];
}) {
  const { t } = useLingui();
  const spots = spotsOf(files);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const done = spots.every((spot) => choices[spot.id] !== undefined);

  async function apply() {
    setBusy(true);
    const resolved: Record<string, string> = {};
    for (const file of files) {
      const picks = spots
        .filter((spot) => spot.path === file.path)
        .map((spot) => textFor(spot.chunk, choices[spot.id] ?? 'draft', own[spot.id]));
      resolved[file.path] = resolveConflict(file, picks);
    }
    try {
      const result = await updateDraft(draft.slug, resolved);
      if (result.kind === 'conflicts') {
        openDraftDialog({ kind: 'conflicts', draft, files: result.files });
        return;
      }
      closeDraftDialog();
      toast.success(t`The draft now includes the latest live wiki.`);
      reloadIntoView();
    } catch (failure) {
      setBusy(false);
      toast.error(t`Couldn't update the draft.`, { description: failureCopy(failure) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDraftDialog()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t`The same text changed in both places`}</DialogTitle>
          <DialogDescription>
            {t`Since this draft started, someone changed the live wiki in the same spots. For each spot, choose what to keep. Everything else was combined automatically.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[65vh] space-y-4 overflow-y-auto">
          {spots.map((spot) => {
            const choice = choices[spot.id];
            const pick = (value: Choice) => setChoices((prev) => ({ ...prev, [spot.id]: value }));
            return (
              <fieldset key={spot.id} className="space-y-2 rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">{docNameOfPath(spot.path)}</legend>
                {spot.before.trim() !== '' ? (
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                    {lastLines(spot.before)}
                  </p>
                ) : null}
                <div className="grid gap-2 sm:grid-cols-2">
                  <Option
                    title={t`Live wiki`}
                    text={spot.chunk.live ?? ''}
                    selected={choice === 'live'}
                    onSelect={() => pick('live')}
                  />
                  <Option
                    title={t`This draft`}
                    text={spot.chunk.draft ?? ''}
                    selected={choice === 'draft'}
                    onSelect={() => pick('draft')}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={choice === 'both' ? 'default' : 'outline'}
                    onClick={() => pick('both')}
                  >
                    {t`Keep both`}
                  </Button>
                  <Button
                    size="sm"
                    variant={choice === 'own' ? 'default' : 'outline'}
                    onClick={() => {
                      setOwn((prev) => ({
                        ...prev,
                        [spot.id]: prev[spot.id] ?? spot.chunk.draft ?? '',
                      }));
                      pick('own');
                    }}
                  >
                    {t`Write it myself`}
                  </Button>
                </div>
                {choice === 'own' ? (
                  <Textarea
                    rows={4}
                    aria-label={t`Your version`}
                    value={own[spot.id] ?? ''}
                    onChange={(event) =>
                      setOwn((prev) => ({ ...prev, [spot.id]: event.target.value }))
                    }
                  />
                ) : null}
              </fieldset>
            );
          })}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={closeDraftDialog} disabled={busy}>
            {t`Not now`}
          </Button>
          <Button onClick={() => void apply()} disabled={!done || busy}>
            {busy ? t`Updating…` : t`Update draft`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Option({
  title,
  text,
  selected,
  onSelect,
}: {
  title: string;
  text: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useLingui();
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'h-auto flex-col items-stretch gap-1 whitespace-normal p-2 text-start font-normal',
        selected && 'border-primary ring-2 ring-primary/30',
      )}
    >
      <span className="text-xs font-medium text-muted-foreground">{t`Keep: ${title}`}</span>
      <span className="whitespace-pre-wrap break-words">
        {text.trim() === '' ? t`(nothing)` : text}
      </span>
    </Button>
  );
}
