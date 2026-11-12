import {
  buildUnresolvedWikiLinkAttrs,
  toWikiLinkSlug,
} from '@/editor/extensions/wiki-link-helpers';

const MAX_ALIAS_LENGTH = 200;

export interface LinkPickerPage {
  docName: string;
  title: string;
}

export type LinkPickerItem =
  | { kind: 'page'; docName: string; title: string; folder: string }
  | { kind: 'create'; title: string };

export interface PickedLinkAttrs {
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
  const slug = toWikiLinkSlug(wanted);
  const exists = pages.some((page) => {
    const name = lastSegment(page.docName);
    return (
      page.title.toLowerCase() === lower ||
      name.toLowerCase() === lower ||
      toWikiLinkSlug(name) === slug
    );
  });
  if (!exists) items.push({ kind: 'create', title: wanted });
  return items;
}

export function aliasFromSelection(selectedText: string): string | null {
  const flat = selectedText.replace(/\s+/g, ' ').trim();
  if (flat === '' || flat.length > MAX_ALIAS_LENGTH || /[[\]|]/.test(flat)) return null;
  return flat;
}

export function linkAttrsFor(item: LinkPickerItem, selectedText: string): PickedLinkAttrs | null {
  const alias = aliasFromSelection(selectedText);
  if (item.kind === 'page') {
    return { target: item.docName, alias: alias === item.docName ? null : alias, anchor: null };
  }
  const attrs = buildUnresolvedWikiLinkAttrs(item.title);
  if (attrs === null) return null;
  return { target: attrs.target, alias: alias ?? attrs.alias, anchor: null };
}

export interface LinkSelection {
  from: number;
  to: number;
  text: string;
  withinOneBlock: boolean;
}

export interface LinkPlacement {
  from: number;
  to: number;
  text: string;
}

export function linkPlacement(captured: string, current: LinkSelection): LinkPlacement {
  const unchanged =
    current.withinOneBlock && current.text === captured && current.from < current.to;
  if (unchanged) return { from: current.from, to: current.to, text: current.text };
  return { from: current.to, to: current.to, text: '' };
}
