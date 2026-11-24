import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GitQuireApiError } from '@/lib/gitquire/branch-api';
import {
  cancelMentionEmail,
  confirmMentionEmail,
  fetchMentions,
  type MentionEmail,
  notifyMentionEmailChanged,
  setMentionEmail,
} from '@/lib/gitquire/mentions-api';

const PENDING_GONE = new Set(['nothing-to-confirm', 'code-expired', 'too-many-tries']);

function emailError(err: unknown, fallback: string, messages: Record<string, string>): string {
  const code = err instanceof GitQuireApiError ? err.code : '';
  return messages[code] ?? fallback;
}

export function MentionEmailForm({
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
        className="flex max-w-md flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() !== '') {
            run(confirmMentionEmail(code), t`Couldn't confirm the address.`, () => setCode(''));
          }
        }}
      >
        <Label htmlFor={codeId}>
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
      className="flex max-w-md flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const address = draft.trim();
        if (address !== '') save(address);
      }}
    >
      <Label htmlFor={fieldId}>
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

type Loaded =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'signed-out' }
  | { kind: 'ready'; email: MentionEmail };

export function MentionEmailSettings() {
  const { t } = useLingui();
  const [state, setState] = useState<Loaded>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetchMentions().then(
      (inbox) => {
        if (!live) return;
        if (!inbox.enabled) setState({ kind: 'signed-out' });
        else
          setState({
            kind: 'ready',
            email: inbox.email ?? { available: false, address: null, pending: null },
          });
      },
      () => {
        if (live) setState({ kind: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <section
      aria-labelledby="settings-notifications-title"
      className="space-y-6"
      data-testid="settings-notifications"
    >
      <SettingsSectionHeader
        titleId="settings-notifications-title"
        title={<Trans>Notifications</Trans>}
        scope="user"
      >
        <Trans>
          When someone mentions you in a comment or an action item in this wiki, it shows up under
          the @ button. You can also get it by email.
        </Trans>
      </SettingsSectionHeader>
      {state.kind === 'loading' && <p className="text-muted-foreground text-sm">{t`Loading…`}</p>}
      {state.kind === 'failed' && (
        <p className="text-muted-foreground text-sm">{t`Couldn't load your email setting.`}</p>
      )}
      {state.kind === 'signed-out' && (
        <p className="text-muted-foreground text-sm">{t`Sign in to get mentions by email.`}</p>
      )}
      {state.kind === 'ready' && !state.email.available && state.email.address === null && (
        <p className="text-muted-foreground text-sm" data-testid="mention-email-unavailable">
          {t`This server can't send email yet. An administrator turns it on with GITQUIRE_SMTP_URL and GITQUIRE_MAIL_FROM.`}
        </p>
      )}
      {state.kind === 'ready' && (state.email.available || state.email.address !== null) && (
        <MentionEmailForm
          email={state.email}
          onChange={(next) => {
            setState({ kind: 'ready', email: next });
            notifyMentionEmailChanged(next);
          }}
        />
      )}
    </section>
  );
}
