import { useLingui } from '@lingui/react/macro';
import { Check, ChevronDown, Folder } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LeftTruncatedName } from '@/components/LeftTruncatedName';
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

export function nameFromPrefix(prefix: string): string {
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
  const fullName = current === undefined ? nameFromPrefix(prefix) : current.fullName;
  const repoName = repository === null ? fullName : `${repository.owner}/${repository.name}`;

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
          <LeftTruncatedName
            name={fullName}
            data-app-header-center-label=""
            data-testid="web-project-name-label"
          />
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
        <DropdownMenuLabel
          className="break-all font-normal text-muted-foreground text-xs"
          data-testid="wiki-menu-current"
        >
          {fullName}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t`Your wikis`}</DropdownMenuLabel>
        {(door?.wikis ?? []).map((wiki) => {
          const isHere = wiki.address === here;
          const name = wiki.fullName;
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
                <LeftTruncatedName name={name} className="flex-1" />
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
              {t`Open ${repoName} on ${host}`}
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href="/">{t`All wikis`}</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={door?.addWikiPage ?? '/add-wiki'}>{t`Add a wiki`}</a>
        </DropdownMenuItem>
        {(door?.signInWith ?? []).map((host) => {
          const label = host.label;
          return (
            <DropdownMenuItem key={host.host} asChild data-sign-in-host={host.host}>
              <a href={`${host.address}?next=${encodeURIComponent(here)}`}>
                {t`Sign in with ${label}`}
              </a>
            </DropdownMenuItem>
          );
        })}
        {door?.severalHosts === true && (
          <DropdownMenuItem asChild>
            <a href="/auth/logout">{t`Sign out…`}</a>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
