import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { FilePlus2, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { fetchPages, filterPages, type PageItem } from '@/editor/extensions/wiki-link-suggestion';
import { type LinkPickerItem, linkAttrsFor, linkPickerItems } from './link-picker';

export interface LinkPickerTarget {
  from: number;
  to: number;
  text: string;
}

const ROW_CLASS = 'h-auto min-h-11 w-full justify-start gap-3 whitespace-normal px-3 text-start';

export function TouchLinkPicker({
  editor,
  target,
  onClose,
}: {
  editor: Editor;
  target: LinkPickerTarget;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<PageItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetchPages().then(
      (found) => {
        if (live) setPages(found.filter((page) => (page.kind ?? 'page') === 'page'));
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const items = pages === null ? [] : linkPickerItems(filterPages(pages, query), query);

  function backToEditor() {
    onClose();
    if (editor.isDestroyed) return;
    const size = editor.state.doc.content.size;
    const from = Math.min(target.from, size);
    const to = Math.min(target.to, size);
    editor.chain().focus().setTextSelection({ from, to }).run();
  }

  function choose(item: LinkPickerItem) {
    const attrs = linkAttrsFor(item, target.text);
    onClose();
    if (attrs === null || editor.isDestroyed) return;
    const size = editor.state.doc.content.size;
    const range = { from: Math.min(target.from, size), to: Math.min(target.to, size) };
    editor.chain().focus().insertContentAt(range, { type: 'wikiLink', attrs }).run();
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) backToEditor();
      }}
    >
      <SheetContent
        side="top"
        className="max-h-[70dvh] gap-3 p-4"
        data-testid="touch-link-picker"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <SheetHeader className="p-0">
          <SheetTitle>{t`Link to a page`}</SheetTitle>
          <SheetDescription className="sr-only">
            {t`Search for a page and choose it to insert a link.`}
          </SheetDescription>
        </SheetHeader>
        <Input
          autoFocus
          type="search"
          enterKeyHint="search"
          value={query}
          placeholder={t`Search pages`}
          aria-label={t`Search pages`}
          onChange={(event) => setQuery(event.target.value)}
        />
        {failed && <p className="text-destructive text-sm">{t`Couldn't load the pages.`}</p>}
        {pages !== null && items.length === 0 && (
          <p className="text-muted-foreground text-sm">{t`No page matches.`}</p>
        )}
        <ul className="flex flex-col gap-1 overflow-y-auto">
          {items.map((item) =>
            item.kind === 'page' ? (
              <li key={`page:${item.docName}`}>
                <Button
                  type="button"
                  variant="ghost"
                  className={ROW_CLASS}
                  onClick={() => choose(item)}
                >
                  <FileText aria-hidden="true" className="shrink-0" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{item.title}</span>
                    {item.folder !== '' && (
                      <span className="truncate text-muted-foreground text-xs">{item.folder}</span>
                    )}
                  </span>
                </Button>
              </li>
            ) : (
              <li key="create">
                <Button
                  type="button"
                  variant="ghost"
                  className={ROW_CLASS}
                  onClick={() => choose(item)}
                >
                  <FilePlus2 aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 truncate">{t`Link to new page "${item.title}"`}</span>
                </Button>
              </li>
            ),
          )}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
