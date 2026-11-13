import { hashFromDocName, hashFromFolderPath } from '@/lib/doc-hash';
import type { ShareTargetInput } from '@/lib/share/run-share-action';

export interface PageLocation {
  origin: string;
  pathname: string;
}

export function gitquirePageLink(target: ShareTargetInput, location: PageLocation): string {
  const hash =
    target.kind === 'doc'
      ? hashFromDocName(target.docName)
      : hashFromFolderPath(target.folderRelativePath);
  return `${location.origin}${location.pathname}${hash}`;
}
