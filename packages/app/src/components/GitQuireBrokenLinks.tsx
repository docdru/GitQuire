import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { Unlink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { useConfigContextOptional } from '@/lib/config-context';
import { hashFromDocName } from '@/lib/doc-hash';
import {
  subscribeToBranchChanged,
  subscribeToDocPersisted,
  subscribeToDocumentsChanged,
} from '@/lib/documents-events';
import {
  type BrokenLink,
  type BrokenLinkReport,
  badgeCount,
  countBrokenLinks,
  fetchBrokenLinks,
  filterBrokenLinks,
  limitBrokenLinks,
  teamBrokenLinks,
} from '@/lib/gitquire/broken-links';
import { revealEditor } from '@/lib/reveal-editor';

const REFRESH_MS = 5 * 60_000;
const CHANGE_SETTLE_MS = 10_000;
const FOCUS_RELOAD_MIN_MS = 15_000;
const MAX_LISTED_SOURCES = 200;

function BrokenLinkCard({ link, onOpen }: { link: BrokenLink; onOpen: (docName: string) => void }) {
  const count = link.sources.length;
  return (
    <li className="flex flex-col gap-1 rounded-lg border p-3">
      <p className="flex items-baseline gap-2">
        <span className="break-all font-medium text-sm">{link.target}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {plural(count, { one: 'linked from # page', other: 'linked from # pages' })}
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

function useBrokenLinkReport(enabled: boolean): {
  report: BrokenLinkReport | null;
  reload: () => void;
} {
  const [report, setReport] = useState<BrokenLinkReport | null>(null);
  const loadNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let latest = 0;
    let lastLoad = 0;
    let settle: number | undefined;
    function load() {
      if (!live || document.hidden) return;
      latest += 1;
      const request = latest;
      lastLoad = Date.now();
      fetchBrokenLinks().then(
        (next) => {
          if (!live || request !== latest) return;
          setReport((previous) => (next.available || previous === null ? next : previous));
          if (!next.available) stop();
        },
        () => undefined,
      );
    }
    function loadSoon() {
      window.clearTimeout(settle);
      settle = window.setTimeout(load, CHANGE_SETTLE_MS);
    }
    function onVisible() {
      if (Date.now() - lastLoad >= FOCUS_RELOAD_MIN_MS) load();
    }
    const timer = window.setInterval(load, REFRESH_MS);
    const unsubscribe = [
      subscribeToBranchChanged(loadSoon),
      subscribeToDocumentsChanged(loadSoon),
      subscribeToDocPersisted(loadSoon),
    ];
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    function stop() {
      live = false;
      window.clearInterval(timer);
      window.clearTimeout(settle);
      for (const off of unsubscribe) off();
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    }
    loadNow.current = load;
    load();
    return stop;
  }, [enabled]);

  return { report, reload: () => loadNow.current() };
}

export function GitQuireBrokenLinks() {
  const { t } = useLingui();
  const validation = useConfigContextOptional()?.merged?.validation;
  const enabled = validation?.links !== 'off';
  const skipLogPages = validation?.suppressLogLinkAdvisories !== false;
  const { report, reload } = useBrokenLinkReport(enabled);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  if (!enabled || report === null || !report.available) return null;

  const links = teamBrokenLinks(report.links, { skipLogPages });
  const total = countBrokenLinks(links);
  const listed = limitBrokenLinks(filterBrokenLinks(links, query), MAX_LISTED_SOURCES);
  const hidden = listed.hidden;

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) reload();
    else setQuery('');
  }

  function openPage(docName: string) {
    changeOpen(false);
    revealEditor();
    window.location.assign(hashFromDocName(docName));
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="relative"
        aria-label={total === 0 ? t`Broken links` : t`Broken links: ${total}`}
        onClick={() => changeOpen(true)}
        data-testid="broken-links-toggle"
      >
        <Unlink aria-hidden="true" className={total === 0 ? 'opacity-60' : undefined} />
        {total > 0 && (
          <span
            aria-hidden="true"
            className="absolute -end-1 -top-1 min-w-4 rounded-full bg-warning/30 px-1 text-center text-[10px] text-foreground leading-4 tabular-nums"
          >
            {badgeCount(total)}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t`Broken links`}</DialogTitle>
            <DialogDescription>
              {t`Links to pages that do not exist. Choose a page to open it and fix the link there.`}
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
            {listed.links.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {total === 0 ? t`No broken links.` : t`Nothing matches the filter.`}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {listed.links.map((link) => (
                  <BrokenLinkCard key={link.target} link={link} onOpen={openPage} />
                ))}
              </ul>
            )}
            {hidden > 0 && (
              <p className="text-muted-foreground text-xs">
                {t`${hidden} more are not listed. Use the filter to narrow the list.`}
              </p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
