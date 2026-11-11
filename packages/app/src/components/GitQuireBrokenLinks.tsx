import { useLingui } from '@lingui/react/macro';
import { Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { hashFromDocName } from '@/lib/doc-hash';
import {
  type BrokenLink,
  type BrokenLinkReport,
  countBrokenLinks,
  fetchBrokenLinks,
  filterBrokenLinks,
} from '@/lib/gitquire/broken-links';
import { unreadBadge } from '@/lib/gitquire/mentions-api';
import { revealEditor } from '@/lib/reveal-editor';

const REFRESH_MS = 5 * 60_000;

const ignore = (): undefined => undefined;

function BrokenLinkCard({ link, onOpen }: { link: BrokenLink; onOpen: (docName: string) => void }) {
  const { t } = useLingui();
  const count = link.sources.length;
  return (
    <li className="flex flex-col gap-1 rounded-lg border p-3">
      <p className="flex items-baseline gap-2">
        <span className="break-all font-medium text-sm">{link.target}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {count === 1 ? t`linked from 1 page` : t`linked from ${count} pages`}
        </span>
      </p>
      <ul className="flex flex-col">
        {link.sources.map((source) => (
          <li key={source.docName}>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full flex-col items-start gap-0.5 whitespace-normal px-2 py-1.5 text-start"
              onClick={() => onOpen(source.docName)}
            >
              <span className="text-sm">{source.title}</span>
              {source.snippet !== null && (
                <span className="line-clamp-2 text-muted-foreground text-xs">{source.snippet}</span>
              )}
            </Button>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function GitQuireBrokenLinks() {
  const { t } = useLingui();
  const [report, setReport] = useState<BrokenLinkReport | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    function load() {
      if (!live || document.hidden) return;
      fetchBrokenLinks().then((next) => {
        if (!live) return;
        setReport(next);
        if (!next.available) stop();
      }, ignore);
    }
    const timer = window.setInterval(load, REFRESH_MS);
    function stop() {
      live = false;
      window.clearInterval(timer);
    }
    load();
    return stop;
  }, []);

  if (report === null || !report.available) return null;
  const total = countBrokenLinks(report.links);
  if (total === 0 && !open) return null;

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) fetchBrokenLinks().then(setReport, ignore);
    else setQuery('');
  }

  function openPage(docName: string) {
    setOpen(false);
    revealEditor();
    window.location.assign(hashFromDocName(docName));
  }

  const shown = filterBrokenLinks(report.links, query);
  const label = t`Broken links: ${unreadBadge(total)}`;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="relative"
        aria-label={label}
        title={label}
        onClick={() => changeOpen(true)}
        data-testid="broken-links-toggle"
      >
        <Unlink aria-hidden="true" />
        <span
          aria-hidden="true"
          className="absolute -end-1 -top-1 min-w-4 rounded-full bg-warning/30 px-1 text-center text-[10px] text-foreground leading-4 tabular-nums"
        >
          {unreadBadge(total)}
        </span>
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t`Broken links`}</DialogTitle>
            <DialogDescription>
              {t`Links to pages that do not exist. Open a page to fix the link, or create the missing page.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex max-h-[60vh] flex-col gap-3">
            <Input
              type="search"
              value={query}
              placeholder={t`Filter by page`}
              aria-label={t`Filter by page`}
              onChange={(event) => setQuery(event.target.value)}
            />
            {shown.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {total === 0 ? t`No broken links.` : t`Nothing matches the filter.`}
              </p>
            ) : (
              <ul className="flex flex-col gap-2 overflow-y-auto">
                {shown.map((link) => (
                  <BrokenLinkCard key={link.target} link={link} onOpen={openPage} />
                ))}
              </ul>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
