import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { GitQuireApiError } from '@/lib/gitquire/branch-api';
import { openView } from '@/lib/gitquire/drafts-api';
import { reloadIntoView } from '@/lib/gitquire/drafts-store';

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
  try {
    await openView(slug);
    reloadIntoView();
  } catch (failure) {
    toast.error(t`Couldn't switch views.`, { description: failureCopy(failure) });
  }
}

export function pageLabel(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}
