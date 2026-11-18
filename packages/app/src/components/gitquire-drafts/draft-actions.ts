import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { GitQuireApiError } from '@/lib/gitquire/branch-api';
import { beginHandover, endHandover, leaveDraft } from '@/lib/gitquire/draft-handover';
import {
  type DraftSummary,
  discardDraft,
  type FileConflict,
  openView,
  publishDraft,
  updateDraft,
} from '@/lib/gitquire/drafts-api';
import { draftSnapshot, refreshDrafts, reloadIntoView } from '@/lib/gitquire/drafts-store';

export function failureCopy(failure: unknown): string {
  if (!(failure instanceof GitQuireApiError)) {
    return t`GitQuire could not be reached. Check your connection and try again.`;
  }
  switch (failure.code) {
    case 'conflict':
      return t`The live wiki changed in the same places. Update the draft first.`;
    case 'no-changes':
      return t`Nothing has changed in this draft yet.`;
    case 'no-recent-edits':
      return t`You have no recent edits on this page, or someone else edited it after you.`;
    case 'draft-closed':
      return t`This draft was already published or discarded.`;
    case 'draft-not-found':
      return t`This draft no longer exists.`;
    case 'sign-in-required':
      return t`Sign in again to continue.`;
    case 'draft-unavailable':
      return t`The draft could not be opened right now. Try again in a moment.`;
    case 'invalid-title':
      return t`Give the draft a name of up to 120 characters.`;
    case 'invalid-people':
      return t`Mention people by their GitHub name, like @anna.`;
    default:
      return failure.message;
  }
}

export async function switchView(slug: string | null): Promise<void> {
  const leavingDraft = draftSnapshot().current?.viewing != null;
  if (leavingDraft) beginHandover();
  try {
    await openView(slug);
    if (leavingDraft) leaveDraft();
    else reloadIntoView();
  } catch (failure) {
    if (leavingDraft) endHandover();
    toast.error(t`Couldn't switch views.`, { description: failureCopy(failure) });
  }
}

export type CloseOutcome =
  | { kind: 'closed' }
  | { kind: 'conflicts'; files: FileConflict[] }
  | { kind: 'failed'; failure: unknown };

function isViewing(draft: Pick<DraftSummary, 'slug'>): boolean {
  return draftSnapshot().current?.viewing?.slug === draft.slug;
}

async function closeAndLeave(
  draft: DraftSummary,
  close: () => Promise<unknown>,
  notices: { leave: string; stay: string },
): Promise<void> {
  await close();
  if (isViewing(draft)) {
    leaveDraft(notices.leave);
    return;
  }
  toast.success(notices.stay);
  void refreshDrafts();
}

function publishedNotices(draft: DraftSummary): { leave: string; stay: string } {
  return {
    leave: t`"${draft.title}" is live. You are now on the live wiki.`,
    stay: t`"${draft.title}" is live.`,
  };
}

async function publishOnce(draft: DraftSummary): Promise<CloseOutcome> {
  try {
    await closeAndLeave(draft, () => publishDraft(draft.slug), publishedNotices(draft));
    return { kind: 'closed' };
  } catch (failure) {
    if (!(failure instanceof GitQuireApiError && failure.code === 'conflict')) {
      return { kind: 'failed', failure };
    }
  }
  try {
    const result = await updateDraft(draft.slug);
    if (result.kind === 'conflicts') return { kind: 'conflicts', files: result.files };
    await closeAndLeave(draft, () => publishDraft(draft.slug), publishedNotices(draft));
    return { kind: 'closed' };
  } catch (failure) {
    return { kind: 'failed', failure };
  }
}

export async function publishAndLeave(draft: DraftSummary): Promise<CloseOutcome> {
  const viewing = isViewing(draft);
  if (viewing) beginHandover();
  const outcome = await publishOnce(draft);
  if (viewing && outcome.kind !== 'closed') endHandover();
  return outcome;
}

export async function discardAndLeave(draft: DraftSummary): Promise<CloseOutcome> {
  const viewing = isViewing(draft);
  if (viewing) beginHandover();
  try {
    await closeAndLeave(draft, () => discardDraft(draft.slug), {
      leave: t`"${draft.title}" was discarded. You are now on the live wiki.`,
      stay: t`"${draft.title}" was discarded.`,
    });
    return { kind: 'closed' };
  } catch (failure) {
    if (viewing) endHandover();
    return { kind: 'failed', failure };
  }
}

export function pageLabel(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}
