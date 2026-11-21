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
import { useGitQuireRepository } from '@/lib/gitquire/repository';
import { type DoorWikis, fetchDoorWikis } from '@/lib/gitquire/wikis';

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
    fetchDoorWikis().then(setDoor, () => undefined);
  }, []);

  const here = `${prefix}/`;
  const host = repository?.host ?? '';
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
