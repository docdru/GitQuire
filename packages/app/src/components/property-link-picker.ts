import { useEffect, useRef, useState } from 'react';
import { fetchPages, filterPages, type PageItem } from '@/editor/extensions/wiki-link-suggestion';

const LINK_QUERY_RE = /\[\[([^[\]|#\n]{0,120})$/;

export interface LinkQuery {
  from: number;
  to: number;
  query: string;
}

export function linkQueryAt(text: string, caret: number): LinkQuery | null {
  const match = LINK_QUERY_RE.exec(text.slice(0, caret));
  if (match === null) return null;
  return { from: match.index, to: caret, query: match[1] };
}

export function insertLink(
  text: string,
  at: LinkQuery,
  docName: string,
): { text: string; caret: number } {
  const after = text.slice(at.to).replace(/^\]\]/, '');
  const link = `[[${docName}]]`;
  return { text: `${text.slice(0, at.from)}${link}${after}`, caret: at.from + link.length };
}

let pagesPromise: Promise<PageItem[]> | null = null;

function loadPages(): Promise<PageItem[]> {
  pagesPromise ||= fetchPages()
    .then((pages) => pages.filter((page) => (page.kind ?? 'page') === 'page'))
    .catch(() => {
      pagesPromise = null;
      return [];
    });
  return pagesPromise;
}

export function resetPropertyLinkPages(): void {
  pagesPromise = null;
}

export interface PropertyLinkPicker {
  open: boolean;
  items: PageItem[];
  selectedIndex: number;
  query: LinkQuery | null;
  update: (text: string, caret: number) => void;
  close: () => void;
  hover: (index: number) => void;
  handleKey: (key: string) => 'next' | 'previous' | 'choose' | 'close' | null;
}

export function usePropertyLinkPicker(): PropertyLinkPicker {
  const [query, setQuery] = useState<LinkQuery | null>(null);
  const [pages, setPages] = useState<PageItem[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (query === null || pages !== null) return;
    void loadPages().then((loaded) => {
      if (mounted.current) setPages(loaded);
    });
  }, [query, pages]);

  const items = query === null || pages === null ? [] : filterPages(pages, query.query);
  const open = query !== null && items.length > 0;

  return {
    open,
    items,
    selectedIndex: Math.min(selectedIndex, Math.max(0, items.length - 1)),
    query,
    update(text, caret) {
      const next = linkQueryAt(text, caret);
      setQuery(next);
      if (next?.query !== query?.query) setSelectedIndex(0);
    },
    close() {
      setQuery(null);
      setSelectedIndex(0);
    },
    hover: setSelectedIndex,
    handleKey(key) {
      if (!open) return null;
      if (key === 'ArrowDown') {
        setSelectedIndex((index) => (index + 1) % items.length);
        return 'next';
      }
      if (key === 'ArrowUp') {
        setSelectedIndex((index) => (index - 1 + items.length) % items.length);
        return 'previous';
      }
      if (key === 'Enter' || key === 'Tab') return 'choose';
      if (key === 'Escape') {
        setQuery(null);
        return 'close';
      }
      return null;
    },
  };
}
