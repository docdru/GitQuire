import { formatRelativeAge } from '@gitquire/core/utils/relative-time';
import { useLingui } from '@lingui/react/macro';
import { AtSign } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { listenMentionPanel } from '@/gitquire-people/mention-events';
import {
  openPageMention,
  PageMentionRows,
  usePageMentions,
} from '@/gitquire-people/PageMentionList';
import { hashFromDocName } from '@/lib/doc-hash';
import { GitQuireApiError } from '@/lib/gitquire/branch-api';
import {
  fetchMentions,
  type InboxMention,
  listenMentionEmailChanged,
  type MentionEmail,
  type MentionInboxData,
  markMentionsRead,
  pageTitle,
  type ReadTarget,
  unreadBadge,
  withMentionsRead,
} from '@/lib/gitquire/mentions-api';
import type { PageMention } from '@/lib/gitquire/page-mentions';
import { revealEditor } from '@/lib/reveal-editor';
import { openNotificationSettings } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
import { revealDiscussion } from './ui-store';

const POLL_MS = 60_000;
const FOCUS_RELOAD_MIN_MS = 10_000;

const ignore = (): undefined => undefined;

function MentionRow({ mention, onOpen }: { mention: InboxMention; onOpen: () => void }) {
  const { t } = useLingui();
  const isTask = mention.kind === 'task';
  const who = mention.author.name ?? mention.author.login ?? mention.author.id;
  const page =
    mention.draft === undefined
      ? pageTitle(mention.docName)
      : t`asks you to review "${mention.draft.title}"`;
  const age = mention.at < '2000' ? '' : formatRelativeAge(mention.at);
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full flex-col items-stretch gap-1 whitespace-normal px-2 py-2 text-start"
        onClick={onOpen}
        data-mention-id={mention.id}
      >
        <span className="flex items-center gap-2 text-muted-foreground text-xs">
          {!mention.read && (
            <span className="size-2 shrink-0 rounded-full bg-primary">
              <span className="sr-only">{t`Unread`}</span>
            </span>
          )}
          {who !== '' && <span className="truncate font-medium text-foreground">{who}</span>}
          {isTask && <span className="shrink-0">{t`Action item`}</span>}
          <span className="truncate">{page}</span>
          <span className="ms-auto shrink-0">{age}</span>
        </span>
        <span className={cn('line-clamp-3 text-sm', mention.read && 'text-muted-foreground')}>
          {mention.body === '' && mention.draft !== undefined
            ? t`Open the draft to review it.`
            : isTask
              ? `☐ ${mention.body}`
              : mention.body}
        </span>
      </Button>
    </li>
  );
}

function EmailHint({ email, onOpen }: { email: MentionEmail; onOpen: () => void }) {
  const { t } = useLingui();
  const text =
    email.address !== null
      ? t`New mentions are emailed to ${email.address}.`
      : email.pending !== null && email.pending !== undefined
        ? t`Waiting for the code sent to ${email.pending}.`
        : t`Email for mentions is not set up.`;
  return (
    <p
      className="flex flex-wrap items-center gap-x-1 border-t px-2 pt-2 text-muted-foreground text-xs"
      data-testid="mention-email-hint"
    >
      <span>{text}</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0 text-xs"
        onClick={onOpen}
      >
        {email.address === null && (email.pending ?? null) === null
          ? t`Set it up in Settings`
          : t`Settings`}
      </Button>
    </p>
  );
}

function PagesTab({
  me,
  person,
  onPerson,
  onOpen,
}: {
  me: string | null;
  person: string | null;
  onPerson: (login: string | null) => void;
  onOpen: (mention: PageMention) => void;
}) {
  const { t } = useLingui();
  const login = person ?? me ?? undefined;
  const { data, reload } = usePageMentions(login !== undefined, login);
  const other = person !== null && person.toLowerCase() !== me?.toLowerCase();
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <p className="px-2 text-muted-foreground text-xs">
        {other
          ? t`Where @${person} is mentioned in the text of a page. These do not notify anyone.`
          : t`Where you are mentioned in the text of a page. These do not notify you.`}
      </p>
      {other && me !== null && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="self-start px-2"
          onClick={() => onPerson(null)}
        >
          {t`Show where I am mentioned`}
        </Button>
      )}
      {data.state === 'loading' && (
        <p className="px-2 text-muted-foreground text-sm">{t`Loading…`}</p>
      )}
      {data.state === 'failed' && (
        <p className="flex items-center gap-2 px-2 text-destructive text-sm">
          {t`Couldn't load the mentions in pages.`}
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t`Try again`}
          </Button>
        </p>
      )}
      {data.state === 'loaded' && data.list.mentions.length === 0 && (
        <p className="px-2 pb-2 text-muted-foreground text-sm">
          {other ? t`No page mentions @${person}.` : t`No page mentions you in its text.`}
        </p>
      )}
      {data.state === 'loaded' && data.list.mentions.length > 0 && (
        <div className="overflow-y-auto">
          <PageMentionRows mentions={data.list.mentions} showPerson={false} onOpen={onOpen} />
          {data.list.truncated && (
            <p className="px-2 text-muted-foreground text-xs">{t`The list is cut off.`}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function MentionInbox() {
  const { t } = useLingui();
  const [inbox, setInbox] = useState<MentionInboxData | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'inbox' | 'pages'>('inbox');
  const [person, setPerson] = useState<string | null>(null);
  const enabled = inbox?.enabled === true;

  useEffect(() => {
    if (!enabled) return;
    return listenMentionPanel((request) => {
      setTab(request.tab);
      setPerson(request.login ?? null);
      setOpen(true);
    });
  }, [enabled]);

  useEffect(
    () =>
      listenMentionEmailChanged((email) =>
        setInbox((latest) => (latest === null ? latest : { ...latest, email })),
      ),
    [],
  );

  useEffect(() => {
    let live = true;
    let lastLoad = 0;
    function load() {
      if (!live || document.hidden) return;
      lastLoad = Date.now();
      fetchMentions().then(
        (next) => {
          if (!live) return;
          setInbox(next);
          if (!next?.enabled) stop();
        },
        (err: unknown) => {
          if (err instanceof GitQuireApiError && err.status === 404) stop();
        },
      );
    }
    function onFocus() {
      if (Date.now() - lastLoad >= FOCUS_RELOAD_MIN_MS) load();
    }
    const timer = window.setInterval(load, POLL_MS);
    window.addEventListener('focus', onFocus);
    function stop() {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    }
    load();
    return stop;
  }, []);

  if (!inbox?.enabled) return null;
  const current = inbox;

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) fetchMentions().then(setInbox, ignore);
    else setPerson(null);
  }

  function openInPage(mention: PageMention) {
    setOpen(false);
    setPerson(null);
    openPageMention(mention);
  }

  function markRead(target: ReadTarget) {
    setInbox(withMentionsRead(current, target));
    markMentionsRead(target).then(
      ({ unread }) => setInbox((latest) => (latest === null ? latest : { ...latest, unread })),
      ignore,
    );
  }

  function openMention(mention: InboxMention) {
    setOpen(false);
    if (!mention.read) markRead({ ids: [mention.id] });
    if (mention.draft !== undefined) {
      const target = `/?draft=${encodeURIComponent(mention.draft.slug)}${window.location.hash}`;
      setTimeout(() => window.location.assign(target), 200);
      return;
    }
    revealEditor();
    window.location.assign(hashFromDocName(mention.docName));
    if (mention.kind !== 'task') revealDiscussion(mention.docName, mention.threadId);
  }

  const email = current.email;
  const label =
    current.unread === 0 ? t`Mentions` : t`Mentions, ${unreadBadge(current.unread)} unread`;

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={label}
          data-testid="mention-inbox-toggle"
        >
          <AtSign aria-hidden="true" />
          {current.unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute -end-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] text-primary-foreground leading-4 tabular-nums"
            >
              {unreadBadge(current.unread)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-[70vh] w-80 flex-col gap-2 p-2">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value === 'pages' ? 'pages' : 'inbox')}
          className="flex min-h-0 flex-col gap-2"
        >
          <div className="flex items-center gap-2 px-2">
            <h2 className="sr-only">{t`Mentions`}</h2>
            <TabsList>
              <TabsTrigger value="inbox" data-testid="mention-tab-inbox">
                {t`Inbox`}
              </TabsTrigger>
              <TabsTrigger value="pages" data-testid="mention-tab-pages">
                {t`In pages`}
              </TabsTrigger>
            </TabsList>
            {tab === 'inbox' && current.unread > 0 && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="ms-auto"
                onClick={() => markRead({ all: true })}
              >
                {t`Mark all as read`}
              </Button>
            )}
          </div>
          <TabsContent value="inbox" className="flex min-h-0 flex-col gap-2">
            {current.mentions.length === 0 ? (
              <p className="px-2 pb-2 text-muted-foreground text-sm">
                {t`Nobody has mentioned you yet. Mentions in comments and action items show up here.`}
              </p>
            ) : (
              <ul className="flex flex-col gap-1 overflow-y-auto">
                {current.mentions.map((mention) => (
                  <MentionRow
                    key={mention.id}
                    mention={mention}
                    onOpen={() => openMention(mention)}
                  />
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="pages" className="flex min-h-0 flex-col">
            <PagesTab me={current.login} person={person} onPerson={setPerson} onOpen={openInPage} />
          </TabsContent>
        </Tabs>
        {tab === 'inbox' && email !== undefined && (email.available || email.address !== null) && (
          <EmailHint
            email={email}
            onOpen={() => {
              setOpen(false);
              openNotificationSettings();
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
