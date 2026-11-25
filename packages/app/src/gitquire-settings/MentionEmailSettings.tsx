import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { GitQuireApiError } from '@/lib/gitquire/branch-api';
import {
  type AccountAddressProblem,
  cancelMentionEmail,
  chooseMentionEmail,
  confirmMentionEmail,
  fetchMentionEmail,
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
  const otherInUse = email.use === 'other' || email.use === undefined ? email.address : null;
  const [draft, setDraft] = useState(otherInUse ?? '');
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
        {otherInUse === null
          ? t`Email me new mentions at another address`
          : t`New mentions are emailed to ${otherInUse}`}
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
          disabled={busy || draft.trim() === '' || draft.trim() === otherInUse}
        >
          {otherInUse === null ? t`Send code` : t`Change`}
        </Button>
      </div>
      {otherInUse !== null && (
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

function problemText(
  why: AccountAddressProblem | null | undefined,
  t: ReturnType<typeof useLingui>['t'],
): string {
  if (why === 'refused') {
    return t`Your Git host does not let GitQuire read your account's email address. An administrator can allow it for the GitQuire app, then sign in again.`;
  }
  if (why === 'domain') return t`This server does not send mail to your account's address.`;
  if (why === 'unreachable') {
    return t`GitQuire could not ask your Git host for your account's address. Sign in again later.`;
  }
  if (why === 'not-read') return t`Sign in again to use your account's address.`;
  return t`Your account has no verified address GitQuire can use.`;
}

export function AccountEmailSwitch({
  email,
  onChange,
}: {
  email: MentionEmail;
  onChange: (next: MentionEmail) => void;
}) {
  const { t } = useLingui();
  const switchId = useId();
  const [busy, setBusy] = useState(false);
  const accountAddress = email.account?.address ?? null;

  function choose(use: 'account' | 'other' | null) {
    if (busy) return;
    setBusy(true);
    chooseMentionEmail(use)
      .then(onChange, () => toast.error(t`Couldn't save the setting. Try again.`))
      .finally(() => setBusy(false));
  }

  if (accountAddress === null) {
    return (
      <div className="flex max-w-md flex-col gap-1" data-testid="mention-email-account">
        {email.stopped === 'account-gone' && (
          <p className="font-medium text-sm">{t`Mention email is stopped.`}</p>
        )}
        <p className="text-muted-foreground text-sm">{problemText(email.account?.why, t)}</p>
      </div>
    );
  }
  return (
    <div className="flex max-w-md flex-col gap-2" data-testid="mention-email-account">
      <div className="flex items-start justify-between gap-4">
        <Label htmlFor={switchId}>{t`Email me mentions at ${accountAddress}`}</Label>
        <Switch
          id={switchId}
          checked={email.use === 'account'}
          disabled={busy}
          onCheckedChange={(checked) => choose(checked ? 'account' : null)}
        />
      </div>
      {email.use !== 'other' && email.other !== null && email.other !== undefined && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="self-start px-0"
          disabled={busy}
          onClick={() => choose('other')}
        >
          {t`Email me at ${email.other} instead`}
        </Button>
      )}
    </div>
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
  const [another, setAnother] = useState(false);

  useEffect(() => {
    let live = true;
    fetchMentionEmail().then(
      (email) => {
        if (live) setState({ kind: 'ready', email });
      },
      (err: unknown) => {
        if (!live) return;
        setState(
          err instanceof GitQuireApiError && err.status === 401
            ? { kind: 'signed-out' }
            : { kind: 'failed' },
        );
      },
    );
    return () => {
      live = false;
    };
  }, []);

  function changed(next: MentionEmail) {
    setState({ kind: 'ready', email: next });
    notifyMentionEmailChanged(next);
  }

  const email = state.kind === 'ready' ? state.email : undefined;
  const showOther =
    email !== undefined && (another || email.use === 'other' || (email.pending ?? null) !== null);

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
          When someone mentions you in a comment or an action item, it shows up under the @ button.
          You can also get it by email. This setting is the same in all wikis you open with this
          account.
        </Trans>
      </SettingsSectionHeader>
      {state.kind === 'loading' && <p className="text-muted-foreground text-sm">{t`Loading…`}</p>}
      {state.kind === 'failed' && (
        <p className="text-muted-foreground text-sm">{t`Couldn't load your email setting.`}</p>
      )}
      {state.kind === 'signed-out' && (
        <p className="text-muted-foreground text-sm">{t`Sign in to get mentions by email.`}</p>
      )}
      {email !== undefined && !email.available && email.address === null && (
        <p className="text-muted-foreground text-sm" data-testid="mention-email-unavailable">
          {t`This server can't send email yet. An administrator turns it on with GITQUIRE_SMTP_URL and GITQUIRE_MAIL_FROM.`}
        </p>
      )}
      {email !== undefined && (email.available || email.address !== null) && (
        <>
          <AccountEmailSwitch email={email} onChange={changed} />
          {showOther ? (
            <MentionEmailForm email={email} onChange={changed} />
          ) : (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0"
              onClick={() => setAnother(true)}
            >
              {t`Use another address`}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
