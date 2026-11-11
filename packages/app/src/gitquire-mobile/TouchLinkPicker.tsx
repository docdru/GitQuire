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
import { type LinkPickerItem, linkAttrsFor, linkPickerItems, linkPlacement } from './link-picker';
import { useKeyboardInset } from './viewport';

export interface LinkPickerTarget {
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
  const [open, setOpen] = useState(true);
  const [chosen, setChosen] = useState<LinkPickerItem | null>(null);
  const inset = useKeyboardInset();

  useEffect(() => {
    let live = true;
    fetchPages().then(
      (found) => {
        if (live) setPages(found.filter((page) => (page.kind ?? 'page') === 'page'));
      },
      () => {
        if (!live) return;
        setFailed(true);
        setPages([]);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const items = pages === null ? [] : linkPickerItems(filterPages(pages, query), query);

  function finish() {
    onClose();
    if (editor.isDestroyed) return;
    if (chosen === null) {
      editor.commands.focus();
      return;
    }
    const { $from, $to, from, to } = editor.state.selection;
    const place = linkPlacement(target.text, {
      from,
      to,
      text: editor.state.doc.textBetween(from, to, ' '),
      withinOneBlock: $from.sameParent($to),
    });
    const attrs = linkAttrsFor(chosen, place.text);
    if (attrs === null) {
      editor.commands.focus();
      return;
    }
    editor
      .chain()
      .focus()
      .insertContentAt({ from: place.from, to: place.to }, { type: 'wikiLink', attrs })
      .run();
  }

  function choose(item: LinkPickerItem) {
    setChosen(item);
    setOpen(false);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="top"
        className="gap-3 p-4"
        style={{ maxHeight: `calc(100dvh - ${inset}px - 1rem)` }}
        data-testid="touch-link-picker"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          finish();
        }}
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
        {pages !== null && !failed && items.length === 0 && (
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
