import { buildUnresolvedWikiLinkAttrs } from '@/editor/extensions/wiki-link-helpers';

const MAX_ALIAS_LENGTH = 200;

export interface LinkPickerPage {
  docName: string;
  title: string;
}

export type LinkPickerItem =
  | { kind: 'page'; docName: string; title: string; folder: string }
  | { kind: 'create'; title: string };

export interface WikiLinkAttrs {
  target: string;
  alias: string | null;
  anchor: null;
}

function lastSegment(docName: string): string {
  return docName.slice(docName.lastIndexOf('/') + 1);
}

function folderOf(docName: string): string {
  const cut = docName.lastIndexOf('/');
  return cut === -1 ? '' : docName.slice(0, cut);
}

export function linkPickerItems(pages: readonly LinkPickerPage[], query: string): LinkPickerItem[] {
  const items: LinkPickerItem[] = pages.map((page) => ({
    kind: 'page',
    docName: page.docName,
    title: page.title === '' ? lastSegment(page.docName) : page.title,
    folder: folderOf(page.docName),
  }));
  const wanted = query.trim();
  if (wanted === '' || buildUnresolvedWikiLinkAttrs(wanted) === null) return items;
  const lower = wanted.toLowerCase();
  const exists = pages.some(
    (page) =>
      page.title.toLowerCase() === lower || lastSegment(page.docName).toLowerCase() === lower,
  );
  if (!exists) items.push({ kind: 'create', title: wanted });
  return items;
}

export function aliasFromSelection(selectedText: string): string | null {
  const flat = selectedText.replace(/\s+/g, ' ').trim();
  if (flat === '' || flat.length > MAX_ALIAS_LENGTH || /[[\]|]/.test(flat)) return null;
  return flat;
}

export function linkAttrsFor(item: LinkPickerItem, selectedText: string): WikiLinkAttrs | null {
  const alias = aliasFromSelection(selectedText);
  if (item.kind === 'page') {
    const redundant = alias === item.title || alias === lastSegment(item.docName);
    return { target: item.docName, alias: redundant ? null : alias, anchor: null };
  }
  const attrs = buildUnresolvedWikiLinkAttrs(item.title);
  if (attrs === null) return null;
  return { target: attrs.target, alias: alias ?? attrs.alias, anchor: null };
}
