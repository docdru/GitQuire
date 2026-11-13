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
  cancelMentionEmail,
  confirmMentionEmail,
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

const PENDING_GONE = new Set(['nothing-to-confirm', 'code-expired', 'too-many-tries']);

function emailError(err: unknown, fallback: string, messages: Record<string, string>): string {
  const code = err instanceof GitQuireApiError ? err.code : '';
  return messages[code] ?? fallback;
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
  const codeId = useId();
  const [draft, setDraft] = useState(email.address ?? '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = email.pending ?? null;
  const messages: Record<string, string> = {
    'invalid-address': t`Enter a valid email address.`,
    'address-not-allowed': t`This server does not send mail to that domain.`,
    'mail-failed': t`The confirmation mail could not be sent. Check the address and try again.`,
    'resend-too-soon': t`Wait a minute before asking for another code.`,
    'too-many-codes': t`Too many confirmation mails for now. Try again later.`,
    'wrong-code': t`That code is not right.`,
    'code-expired': t`The code has expired. Ask for a new one.`,
    'too-many-tries': t`Too many wrong codes. Ask for a new one.`,
    'nothing-to-confirm': t`There is no address waiting for a code.`,
  };

  function run(request: Promise<MentionEmail>, fallback: string, done?: () => void) {
    if (busy) return;
    setBusy(true);
    request
      .then(
        (next) => {
          onChange(next);
          done?.();
        },
        (err: unknown) => {
          toast.error(emailError(err, fallback, messages));
          const reason = err instanceof GitQuireApiError ? err.code : '';
          if (PENDING_GONE.has(reason)) onChange({ ...email, pending: null });
        },
      )
      .finally(() => setBusy(false));
  }

  function save(address: string | null) {
    run(setMentionEmail(address), t`Couldn't save the email address.`, () => {
      setCode('');
      if (address === null) setDraft('');
    });
  }

  if (pending !== null) {
    return (
      <form
        className="flex flex-col gap-1.5 border-t px-2 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() !== '') {
            run(confirmMentionEmail(code), t`Couldn't confirm the address.`, () => setCode(''));
          }
        }}
      >
        <Label htmlFor={codeId} className="text-xs">
          {t`We sent a code to ${pending}. Enter it to turn on email.`}
        </Label>
        <div className="flex gap-2">
          <Input
            id={codeId}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            value={code}
            placeholder={t`ABCD-2345`}
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || code.trim() === ''}>
            {t`Confirm`}
          </Button>
        </div>
        {email.address !== null && (
          <p className="text-muted-foreground text-xs">
            {t`Until then, mentions still go to ${email.address}.`}
          </p>
        )}
        <div className="flex gap-3">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0"
            disabled={busy}
            onClick={() => save(pending)}
          >
            {t`Send a new code`}
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0"
            disabled={busy}
            onClick={() => run(cancelMentionEmail(), t`Couldn't cancel.`)}
          >
            {t`Cancel`}
          </Button>
        </div>
      </form>
    );
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
        {email.address === null
          ? t`Email me new mentions`
          : t`New mentions are emailed to ${email.address}`}
      </Label>
      <div className="flex gap-2">
        <Input
          id={fieldId}
          type="email"
          autoComplete="email"
          value={draft}
          placeholder={t`name@example.com`}
          disabled={busy || !email.available}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          disabled={busy || draft.trim() === '' || draft.trim() === email.address}
        >
          {email.address === null ? t`Send code` : t`Change`}
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
            {t`Nobody has mentioned you yet. Mentions in comments show up here.`}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 overflow-y-auto">
            {current.mentions.map((mention) => (
              <MentionRow key={mention.id} mention={mention} onOpen={() => openMention(mention)} />
            ))}
          </ul>
        )}
        {email !== undefined && (email.available || email.address !== null) && (
          <EmailSetting
            email={email}
            onChange={(next) =>
              setInbox((latest) => (latest === null ? latest : { ...latest, email: next }))
            }
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
