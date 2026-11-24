import { useLingui } from '@lingui/react/macro';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { hashFromDocName } from '@/lib/doc-hash';
import { pageTitle } from '@/lib/gitquire/mentions-api';
import {
  fetchPageMentions,
  groupByPage,
  onlyKnown,
  type PageMention,
  type PageMentionList as PageMentionData,
} from '@/lib/gitquire/page-mentions';
import { knownLogins, usePeople } from '@/lib/gitquire/people';
import { revealEditor } from '@/lib/reveal-editor';
import { revealPageMention } from './mention-events';

export function openPageMention(mention: PageMention): void {
  revealEditor();
  revealPageMention({
    docName: mention.docName,
    login: mention.login,
    occurrence: mention.occurrence,
    snippet: mention.snippet,
  });
  window.location.assign(hashFromDocName(mention.docName));
}

export type PageMentionState =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; list: PageMentionData };

function loadInto(
  generation: RefObject<number>,
  login: string | undefined,
  setData: (next: PageMentionState) => void,
): void {
  generation.current += 1;
  const mine = generation.current;
  setData({ state: 'loading' });
  fetchPageMentions(login).then(
    (list) => {
      if (generation.current === mine) setData({ state: 'loaded', list });
    },
    () => {
      if (generation.current === mine) setData({ state: 'failed' });
    },
  );
}

export function usePageMentions(
  active: boolean,
  login?: string,
): {
  data: PageMentionState;
  reload: () => void;
} {
  const [data, setData] = useState<PageMentionState>({ state: 'loading' });
  const generation = useRef(0);
  const { people } = usePeople();
  const known = knownLogins(people);

  useEffect(() => {
    if (!active) return;
    loadInto(generation, login, setData);
    return () => {
      generation.current += 1;
    };
  }, [active, login]);

  const shown: PageMentionState =
    data.state === 'loaded'
      ? { state: 'loaded', list: { ...data.list, mentions: onlyKnown(data.list.mentions, known) } }
      : data;
  return { data: shown, reload: () => loadInto(generation, login, setData) };
}

export function PageMentionRows({
  mentions,
  showPerson,
  onOpen,
}: {
  mentions: readonly PageMention[];
  showPerson: boolean;
  onOpen: (mention: PageMention) => void;
}) {
  const { t } = useLingui();
  return (
    <ul className="flex flex-col gap-2" data-testid="page-mention-rows">
      {groupByPage(mentions).map((group) => (
        <li key={group.docName} className="flex flex-col gap-0.5">
          <span className="truncate px-2 font-medium text-muted-foreground text-xs">
            {pageTitle(group.docName)}
          </span>
          <ul className="flex flex-col">
            {group.mentions.map((mention) => (
              <li key={mention.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full flex-col items-stretch gap-0.5 whitespace-normal px-2 py-1.5 text-start"
                  data-page-mention-id={mention.id}
                  onClick={() => onOpen(mention)}
                >
                  <span className="flex items-center gap-2 text-muted-foreground text-xs">
                    {showPerson && (
                      <span className="shrink-0 font-medium text-foreground">@{mention.login}</span>
                    )}
                    {mention.heading !== '' && <span className="truncate">{mention.heading}</span>}
                  </span>
                  <span className="line-clamp-2 text-sm">{mention.snippet}</span>
                  <span className="sr-only">{t`Open the page at this mention`}</span>
                </Button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
