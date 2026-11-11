import { formatRelativeAge } from '@inkeep/open-knowledge-core/utils/relative-time';
import { useLingui } from '@lingui/react/macro';
import { AtSign } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { hashFromDocName } from '@/lib/doc-hash';
import { GitQuireApiError } from '@/lib/gitquire/branch-api';
import {
  fetchMentions,
  type InboxMention,
  type MentionEmail,
  type MentionInboxData,
  markMentionsRead,
  pageTitle,
  type ReadTarget,
  setMentionEmail,
  unreadBadge,
  withMentionsRead,
} from '@/lib/gitquire/mentions-api';
import { revealEditor } from '@/lib/reveal-editor';
import { cn } from '@/lib/utils';
import { revealDiscussion } from './ui-store';

const POLL_MS = 60_000;
const FOCUS_RELOAD_MIN_MS = 10_000;

const ignore = (): undefined => undefined;

function MentionRow({ mention, onOpen }: { mention: InboxMention; onOpen: () => void }) {
  const { t } = useLingui();
  const who = mention.author.name ?? mention.author.login ?? mention.author.id;
  const page = pageTitle(mention.docName);
  const age = formatRelativeAge(mention.at);
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
          <span className="truncate font-medium text-foreground">{who}</span>
          <span className="truncate">{page}</span>
          <span className="ms-auto shrink-0">{age}</span>
        </span>
        <span className={cn('line-clamp-3 text-sm', mention.read && 'text-muted-foreground')}>
          {mention.body}
        </span>
      </Button>
    </li>
  );
}

function EmailSetting({
  email,
  onChange,
}: {
  email: MentionEmail;
  onChange: (next: MentionEmail) => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const [draft, setDraft] = useState(email.address ?? '');
  const [busy, setBusy] = useState(false);

  function save(address: string | null) {
    if (busy) return;
    setBusy(true);
    setMentionEmail(address)
      .then(
        (next) => {
          onChange(next);
          if (next.address === null) setDraft('');
        },
        (err: unknown) => {
          toast.error(
            err instanceof GitQuireApiError ? err.message : t`Couldn't save the email address.`,
          );
        },
      )
      .finally(() => setBusy(false));
  }

  return (
    <form
      className="flex flex-col gap-1.5 border-t px-2 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        const address = draft.trim();
        if (address !== '') save(address);
      }}
    >
      <Label htmlFor={fieldId} className="text-xs">
        {t`Email me new mentions`}
      </Label>
      <div className="flex gap-2">
        <Input
          id={fieldId}
          type="email"
          autoComplete="email"
          value={draft}
          placeholder={t`name@example.com`}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          disabled={busy || draft.trim() === '' || draft.trim() === email.address}
        >
          {t`Save`}
        </Button>
      </div>
      {email.address !== null && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="self-start px-0"
          disabled={busy}
          onClick={() => save(null)}
        >
          {t`Stop emailing me`}
        </Button>
      )}
    </form>
  );
}

export function MentionInbox() {
  const { t } = useLingui();
  const [inbox, setInbox] = useState<MentionInboxData | null>(null);
  const [open, setOpen] = useState(false);

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
          if (!next.enabled) stop();
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

  if (inbox === null || !inbox.enabled) return null;
  const current = inbox;

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) fetchMentions().then(setInbox, ignore);
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
    revealEditor();
    window.location.assign(hashFromDocName(mention.docName));
    revealDiscussion(mention.docName, mention.threadId);
  }

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
        <div className="flex items-center gap-2 px-2">
          <h2 className="font-medium text-sm">{t`Mentions`}</h2>
          {current.unread > 0 && (
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
        {current.mentions.length === 0 ? (
          <p className="px-2 pb-2 text-muted-foreground text-sm">
            {t`Nobody has mentioned you yet. Mentions in discussions show up here.`}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 overflow-y-auto">
            {current.mentions.map((mention) => (
              <MentionRow key={mention.id} mention={mention} onOpen={() => openMention(mention)} />
            ))}
          </ul>
        )}
        {current.email?.available === true && (
          <EmailSetting
            email={current.email}
            onChange={(email) =>
              setInbox((latest) => (latest === null ? latest : { ...latest, email }))
            }
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
