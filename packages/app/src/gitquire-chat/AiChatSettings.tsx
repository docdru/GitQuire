import { Trans, useLingui } from '@lingui/react/macro';
import { ExternalLink, KeyRound } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ChatApiError,
  type ChatKeyInfo,
  type ChatOverview,
  type ChatProviderInfo,
  type ChatUsageReport,
  fetchChatOverview,
  fetchChatUsage,
  formatTokens,
  removeChatKey,
  saveChatKey,
} from '@/lib/gitquire/chat-api';
import { notifyChatKeysChanged } from './chat-keys-events';

function ProviderKey({
  provider,
  onChange,
}: {
  provider: ChatProviderInfo;
  onChange: (key: ChatKeyInfo) => void;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { key } = provider;

  async function save() {
    if (value.trim() === '') return;
    setBusy(true);
    setError(null);
    const outcome = await saveChatKey(provider.id, value).then(
      (key) => ({ key, failure: null }),
      (err: unknown) => ({ key: null, failure: err }),
    );
    setBusy(false);
    if (outcome.key !== null) {
      onChange(outcome.key);
      setValue('');
      notifyChatKeysChanged();
      toast.success(t`Key saved for ${provider.label}.`);
      return;
    }
    setError(
      outcome.failure instanceof ChatApiError
        ? outcome.failure.message
        : t`The key could not be saved.`,
    );
  }

  async function remove() {
    setBusy(true);
    const key = await removeChatKey(provider.id).catch(() => null);
    setBusy(false);
    if (key === null) {
      toast.error(t`The key could not be removed. Try again.`);
      return;
    }
    onChange(key);
    notifyChatKeysChanged();
    toast.success(t`Key removed for ${provider.label}.`);
  }

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid={`ai-chat-key-${provider.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{provider.label}</span>
        {key.configured ? (
          <Badge variant="secondary">{t`Saved ${key.hint ?? ''}`}</Badge>
        ) : key.unreadable ? (
          <Badge variant="destructive">{t`Enter it again`}</Badge>
        ) : (
          <Badge variant="outline">{t`No key`}</Badge>
        )}
      </div>
      {key.unreadable ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            The saved key can no longer be read, usually because the server's session secret
            changed. Paste it again.
          </Trans>
        </p>
      ) : null}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={inputId} className="text-xs">
            {key.configured ? t`Replace the API key` : t`API key`}
          </Label>
          <Input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t`Paste your ${provider.label} API key`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={busy}
          />
        </div>
        <Button type="submit" size="sm" disabled={busy || value.trim() === ''}>
          {busy ? t`Checking…` : t`Save`}
        </Button>
        {key.configured || key.unreadable ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={remove}>
            {t`Remove`}
          </Button>
        ) : null}
      </form>
      {error !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm" className="gap-1">
          <a href={provider.keyUrl} target="_blank" rel="noreferrer">
            {t`Get an API key`}
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </Button>
        <Button asChild variant="outline" size="sm" className="gap-1">
          <a href={provider.limitsUrl} target="_blank" rel="noreferrer">
            {t`Set a spending limit`}
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}

const DAYS_SHOWN = 14;
const CHATS_SHOWN = 10;

function UsageTable({
  label,
  rows,
}: {
  label: string;
  rows: Array<{ key: string; name: string; detail?: string; input: number; output: number }>;
}) {
  return (
    <table className="w-full text-sm" aria-label={label}>
      <thead className="text-muted-foreground text-xs">
        <tr>
          <th className="py-1 text-start font-normal">{label}</th>
          <th className="py-1 text-end font-normal">
            <Trans>In</Trans>
          </th>
          <th className="py-1 text-end font-normal">
            <Trans>Out</Trans>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-t">
            <td className="py-1 pe-2">
              <span className="block truncate">{row.name}</span>
              {row.detail === undefined ? null : (
                <span className="block text-muted-foreground text-xs">{row.detail}</span>
              )}
            </td>
            <td className="py-1 text-end tabular-nums">{formatTokens(row.input)}</td>
            <td className="py-1 text-end tabular-nums">{formatTokens(row.output)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UsageHistory() {
  const { t } = useLingui();
  const titleId = useId();
  const [usage, setUsage] = useState<ChatUsageReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stale = false;
    fetchChatUsage().then(
      (value) => {
        if (!stale) setUsage(value);
      },
      () => {
        if (!stale) setFailed(true);
      },
    );
    return () => {
      stale = true;
    };
  }, []);

  if (usage === null) {
    return failed ? (
      <p className="text-muted-foreground text-sm">{t`Your token usage could not be loaded.`}</p>
    ) : null;
  }
  const input = formatTokens(usage.total.inputTokens);
  const output = formatTokens(usage.total.outputTokens);
  const days = usage.retentionDays;
  return (
    <section aria-labelledby={titleId} className="space-y-3" data-testid="ai-chat-usage-history">
      <p id={titleId} className="font-medium text-sm">
        <Trans>Your token usage</Trans>
      </p>
      {usage.days.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>No tokens used in the last {days} days.</Trans>
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-sm" data-testid="ai-chat-usage-total">
            <Trans>
              Last {days} days: {input} tokens in, {output} out. Your provider's bill is based on
              these counts; GitQuire does not know the prices.
            </Trans>
          </p>
          <UsageTable
            label={t`Day`}
            rows={usage.days.slice(0, DAYS_SHOWN).map((day) => ({
              key: day.day,
              name: day.day,
              input: day.inputTokens,
              output: day.outputTokens,
            }))}
          />
          <UsageTable
            label={t`Chat`}
            rows={usage.chats.slice(0, CHATS_SHOWN).map((chat) => ({
              key: chat.chatId,
              name: chat.title,
              detail: `${chat.model} · ${chat.lastDay}`,
              input: chat.inputTokens,
              output: chat.outputTokens,
            }))}
          />
        </>
      )}
    </section>
  );
}

export function AiChatSettings() {
  const { t } = useLingui();
  const titleId = useId();
  const [overview, setOverview] = useState<ChatOverview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stale = false;
    fetchChatOverview().then(
      (value) => {
        if (!stale) setOverview(value);
      },
      () => {
        if (!stale) setFailed(true);
      },
    );
    return () => {
      stale = true;
    };
  }, []);

  return (
    <section aria-labelledby={titleId} className="space-y-6" data-testid="ai-chat-settings">
      <SettingsSectionHeader titleId={titleId} title={<Trans>AI chat</Trans>}>
        <Trans>
          Chat with Claude or Mistral right inside the wiki. The assistant can search and read pages
          and, when you ask, change them; its changes are saved as your edits. It uses your own API
          key, so you pay the provider for what you use.
        </Trans>
      </SettingsSectionHeader>
      <div className="space-y-2 rounded-lg bg-muted/50 p-4 text-sm">
        <p className="font-medium">
          <Trans>Keep the cost under control</Trans>
        </p>
        <ul className="list-disc space-y-1 ps-5 text-muted-foreground">
          <li>
            <Trans>
              Set a monthly spending limit at the provider (links below). It stops the key once the
              limit is reached.
            </Trans>
          </li>
          <li>
            <Trans>
              The chat shows how many tokens each conversation used. Long chats cost more, because
              the whole conversation is sent with every message; start a new chat for a new topic.
            </Trans>
          </li>
          <li>
            <Trans>The smaller models are much cheaper and fine for most questions.</Trans>
          </li>
        </ul>
      </div>
      {overview === null ? (
        <p className="text-muted-foreground text-sm">
          {failed ? t`The AI chat settings could not be loaded.` : t`Loading…`}
        </p>
      ) : (
        <>
          <div className="space-y-4">
            {overview.providers.map((provider) => (
              <ProviderKey
                key={provider.id}
                provider={provider}
                onChange={(key) =>
                  setOverview((current) =>
                    current === null
                      ? current
                      : {
                          ...current,
                          providers: current.providers.map((entry) =>
                            entry.id === provider.id ? { ...entry, key } : entry,
                          ),
                        },
                  )
                }
              />
            ))}
          </div>
          <UsageHistory />
          <p className="text-muted-foreground text-sm">
            <Trans>
              Keys are stored encrypted on the wiki server, used only for your own chats and never
              shown again. Your chats are kept on the server for {overview.retentionDays} days after
              the last message and are only shown to you; whoever runs the server can technically
              read both. Token counts per day and per chat are kept for the same time, also after
              you delete a chat. Use “Save as page” to keep a chat in the wiki.
            </Trans>
          </p>
        </>
      )}
    </section>
  );
}
