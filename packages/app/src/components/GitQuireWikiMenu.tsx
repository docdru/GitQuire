import { useLingui } from '@lingui/react/macro';
import { Check, ChevronDown, Folder } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { unreadBadge } from '@/lib/gitquire/mentions-api';
import { useGitQuireRepository } from '@/lib/gitquire/repository';
import { type DoorWikis, fetchDoorWikis, unreadElsewhere } from '@/lib/gitquire/wikis';

const POLL_MS = 60_000;
const BADGE_CLASS =
  'min-w-4 shrink-0 rounded-full bg-primary px-1 text-center text-[10px] text-primary-foreground leading-4 tabular-nums';

const LABEL_CLASS = 'min-w-0 gap-1.5 px-2 font-normal text-foreground text-sm';

function nameFromPrefix(prefix: string): string {
  return prefix.replace(/^\/w\//, '');
}

export function GitQuireWikiMenu({ prefix }: { prefix: string }) {
  const { t } = useLingui();
  const repository = useGitQuireRepository();
  const [door, setDoor] = useState<DoorWikis | null>(null);

  const load = () => {
    fetchDoorWikis().then(setDoor, () => undefined);
  };

  useEffect(() => {
    let live = true;
    function poll() {
      if (document.hidden) return;
      fetchDoorWikis().then(
        (next) => {
          if (live) setDoor(next);
        },
        () => undefined,
      );
    }
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const here = `${prefix}/`;
  const host = repository?.host ?? '';
  const elsewhere = unreadElsewhere(door, here);
  const current = door?.wikis.find((wiki) => wiki.address === here);
  const fullName =
    current === undefined
      ? repository === null
        ? nameFromPrefix(prefix)
        : `${repository.owner}/${repository.name}`
      : `${current.owner}/${current.name}`;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="web-project-name"
          className={LABEL_CLASS}
        >
          <Folder aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only">{t`Repository`}</span>
          <span
            className="min-w-0 truncate"
            data-app-header-center-label=""
            data-testid="web-project-name-label"
          >
            {fullName}
          </span>
          {elsewhere > 0 && (
            <span className={BADGE_CLASS} data-testid="wiki-menu-badge">
              <span aria-hidden="true">{unreadBadge(elsewhere)}</span>
              <span className="sr-only">{t`Other wikis, ${unreadBadge(elsewhere)} unread`}</span>
            </span>
          )}
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-72" data-testid="wiki-menu">
        <DropdownMenuLabel>{t`Your wikis`}</DropdownMenuLabel>
        {(door?.wikis ?? []).map((wiki) => {
          const isHere = wiki.address === here;
          const name = `${wiki.owner}/${wiki.name}`;
          return (
            <DropdownMenuItem
              key={wiki.key}
              asChild
              disabled={wiki.state !== 'on'}
              data-wiki={wiki.key}
            >
              <a
                href={wiki.address}
                aria-current={isHere ? 'page' : undefined}
                title={wiki.why ?? undefined}
              >
                <Check
                  aria-hidden="true"
                  className={isHere ? 'size-4 shrink-0' : 'size-4 shrink-0 opacity-0'}
                />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {wiki.unread > 0 && (
                  <span className={BADGE_CLASS} data-unread={wiki.unread}>
                    {unreadBadge(wiki.unread)}
                    <span className="sr-only"> {t`Unread`}</span>
                  </span>
                )}
                {wiki.state !== 'on' && (
                  <span className="shrink-0 text-muted-foreground text-xs">{t`Disconnected`}</span>
                )}
              </a>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        {repository !== null && (
          <DropdownMenuItem asChild>
            <a href={repository.url} target="_blank" rel="noreferrer">
              {t`Open ${fullName} on ${host}`}
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href="/">{t`All wikis`}</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={door?.addWikiPage ?? '/add-wiki'}>{t`Add a wiki`}</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
