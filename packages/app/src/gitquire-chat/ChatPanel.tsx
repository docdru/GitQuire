import { Trans, useLingui } from '@lingui/react/macro';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  FilePlus2,
  History,
  MoreHorizontal,
  Plus,
  Search,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { hashFromDocName } from '@/lib/doc-hash';
import {
  ChatApiError,
  type ChatEvent,
  type ChatMessage,
  type ChatOverview,
  type ChatProvider,
  type ChatSummary,
  deleteChat,
  fetchChat,
  fetchChatOverview,
  formatTokens,
  listChats,
  saveChatAsPage,
  sendChatMessage,
  type ToolActivity,
  toolActivity,
} from '@/lib/gitquire/chat-api';
import { onChatRequest, takeChatRequest } from '@/lib/gitquire/chat-requests';
import { useCurrentDocName } from '@/lib/gitquire/use-current-doc';
import { openAiChatSettings } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
import { ChatMarkdown, ChatPlainText } from './ChatMarkdown';
import { onChatKeysChanged } from './chat-keys-events';

const MODEL_STORAGE_KEY = 'gitquire.aiChat.model';
const MAX_INPUT_HEIGHT_PX = 200;

type Item =
  | { kind: 'user'; key: string; text: string; page?: string }
  | { kind: 'assistant'; key: string; text: string }
  | {
      kind: 'tool';
      key: string;
      id: string;
      activity: ToolActivity;
      state: 'running' | 'done' | 'failed';
    }
  | { kind: 'error'; key: string; code: string; message: string }
  | { kind: 'notice'; key: string; text: string };

interface Selection {
  provider: ChatProvider;
  model: string;
}

function itemsFromMessages(messages: readonly ChatMessage[]): Item[] {
  const items: Item[] = [];
  const failed = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const result of message.results) if (result.isError) failed.add(result.id);
    }
  }
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      items.push({ kind: 'user', key: `m${index}`, text: message.text, page: message.page });
    } else if (message.role === 'assistant') {
      if (message.text.trim() !== '') {
        items.push({ kind: 'assistant', key: `m${index}`, text: message.text });
      }
      for (const call of message.toolCalls) {
        items.push({
          kind: 'tool',
          key: `m${index}-${call.id}`,
          id: call.id,
          activity: toolActivity(call.name, call.input),
          state: failed.has(call.id) ? 'failed' : 'done',
        });
      }
    }
  });
  return items;
}

function loadSelection(): Selection | null {
  try {
    const raw = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Selection;
    return parsed.provider === 'claude' || parsed.provider === 'mistral' ? parsed : null;
  } catch {
    return null;
  }
}

function storeSelection(selection: Selection): void {
  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(selection));
  } catch {}
}

export function pickSelection(overview: ChatOverview, stored: Selection | null): Selection | null {
  const usable = overview.providers.filter((provider) => provider.key.configured);
  const storedProvider = usable.find((provider) => provider.id === stored?.provider);
  if (storedProvider !== undefined && stored !== null) {
    const model = storedProvider.models.some((entry) => entry.id === stored.model)
      ? stored.model
      : storedProvider.defaultModel;
    return { provider: storedProvider.id, model };
  }
  const first = usable[0];
  return first === undefined ? null : { provider: first.id, model: first.defaultModel };
}

function ToolLine({ item }: { item: Item & { kind: 'tool' } }) {
  const { t } = useLingui();
  const { kind, detail } = item.activity;
  const label = (() => {
    switch (kind) {
      case 'search':
        return detail === null ? t`Searched the wiki` : t`Searched “${detail}”`;
      case 'read':
        return detail === null ? t`Read pages` : t`Looked at: ${detail}`;
      case 'write':
        return detail === null ? t`Wrote pages` : t`Wrote ${detail}`;
      case 'edit':
        return detail === null ? t`Edited a page` : t`Edited ${detail}`;
      case 'move':
        return t`Moved a page`;
      case 'links':
        return t`Looked at links`;
      case 'history':
        return t`Looked at the page history`;
      case 'lint':
        return t`Checked pages`;
      default:
        return t`Used ${detail ?? ''}`;
    }
  })();
  const Icon = kind === 'search' || kind === 'read' ? Search : Wrench;
  const page = (kind === 'write' || kind === 'edit') && detail !== null ? detail : null;
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-muted-foreground text-xs',
        item.state === 'failed' && 'text-destructive',
      )}
      data-testid="ai-chat-tool"
    >
      {item.state === 'running' ? (
        <Spinner aria-hidden="true" className="size-3" />
      ) : item.state === 'failed' ? (
        <AlertTriangle aria-hidden="true" className="size-3" />
      ) : (
        <Icon aria-hidden="true" className="size-3" />
      )}
      {page === null ? (
        <span className="truncate">{label}</span>
      ) : (
        <a href={hashFromDocName(page)} className="truncate hover:underline">
          {label}
        </a>
      )}
      {item.state === 'failed' ? <span className="sr-only">{t`(failed)`}</span> : null}
    </div>
  );
}

function ErrorLine({ item }: { item: Item & { kind: 'error' } }) {
  const { t } = useLingui();
  const hint = (() => {
    switch (item.code) {
      case 'invalid-key':
        return t`Check your API key in Settings → AI chat.`;
      case 'context-too-long':
        return t`This chat is too long for the model. Start a new chat (+) to go on.`;
      case 'no-key':
        return t`Add your API key in Settings → AI chat first.`;
      case 'no-credit':
        return t`Add credit to your account at the provider.`;
      case 'spend-limit':
        return t`Your spending limit at the provider was reached. Raise it there or wait until next month.`;
      case 'rate-limited':
        return t`The provider asks to slow down. Wait a minute and try again.`;
      case 'overloaded':
        return t`The provider is busy. Try again in a moment.`;
      case 'model-unavailable':
        return t`This model is not available for your key. Choose another one.`;
      default:
        return null;
    }
  })();
  return (
    <div
      role="alert"
      className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
    >
      <p className="font-medium text-destructive">{hint ?? t`Something went wrong.`}</p>
      <p className="break-words text-muted-foreground text-xs">{item.message}</p>
      {item.code === 'invalid-key' || item.code === 'no-key' ? (
        <Button variant="outline" size="sm" onClick={() => openAiChatSettings()}>
          {t`Open settings`}
        </Button>
      ) : null}
    </div>
  );
}

function SaveAsPageDialog({
  open,
  onOpenChange,
  suggestedPath,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestedPath: string;
  onSave: (path: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const [path, setPath] = useState(suggestedPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPath(suggestedPath);
      setError(null);
    }
  }, [open, suggestedPath]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Save chat as a page`}</DialogTitle>
          <DialogDescription>
            <Trans>
              The conversation is written to a new wiki page as your edit, so the team can read it.
              Tool details are summarised.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${inputId}-form`}
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            const failure = await onSave(path).then(
              () => null,
              (err: unknown) => err,
            );
            setBusy(false);
            if (failure === null) {
              onOpenChange(false);
              return;
            }
            setError(failure instanceof Error ? failure.message : t`The page could not be saved.`);
          }}
        >
          <label htmlFor={inputId} className="text-sm">
            {t`Page`}
          </label>
          <Input id={inputId} value={path} onChange={(event) => setPath(event.target.value)} />
          {error !== null ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t`Cancel`}
          </Button>
          <Button type="submit" form={`${inputId}-form`} disabled={busy || path.trim() === ''}>
            {busy ? t`Saving…` : t`Save page`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChatPanel() {
  const { t } = useLingui();
  const currentDoc = useCurrentDocName();
  const [overview, setOverview] = useState<ChatOverview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [usage, setUsage] = useState({ input: 0, output: 0 });
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [suggestedPath, setSuggestedPath] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const counter = useRef(0);

  const loadOverview = useEffectEvent(() => {
    fetchChatOverview().then(
      (value) => {
        setOverview(value);
        setLoadFailed(false);
        setSelection((current) => pickSelection(value, current ?? loadSelection()));
      },
      () => setLoadFailed(true),
    );
  });

  function refreshChats() {
    listChats().then(setChats, () => undefined);
  }
  const refreshChatsOnMount = useEffectEvent(refreshChats);

  useEffect(() => {
    loadOverview();
    refreshChatsOnMount();
    return onChatKeysChanged(() => loadOverview());
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message whenever the list changes
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [items]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const nextKey = () => {
    counter.current += 1;
    return `live-${counter.current}`;
  };

  function startNewChat() {
    if (sending) return;
    setChatId(null);
    setTitle(null);
    setItems([]);
    setUsage({ input: 0, output: 0 });
    inputRef.current?.focus();
  }

  async function openChat(id: string) {
    if (sending) return;
    try {
      const { chat, suggestedPath: path } = await fetchChat(id);
      setChatId(chat.id);
      setTitle(chat.title);
      setItems(itemsFromMessages(chat.messages));
      setUsage({ input: chat.usage.inputTokens, output: chat.usage.outputTokens });
      setSuggestedPath(path);
    } catch {
      toast.error(t`The chat could not be opened.`);
      refreshChats();
    }
  }

  async function removeChat(id: string) {
    try {
      await deleteChat(id);
      if (id === chatId) startNewChat();
      refreshChats();
    } catch {
      toast.error(t`The chat could not be deleted.`);
    }
  }

  function handleEvent(event: ChatEvent) {
    switch (event.type) {
      case 'chat':
        setChatId(event.id);
        setTitle(event.title);
        return;
      case 'text':
        setItems((current) => [
          ...current,
          { kind: 'assistant', key: nextKey(), text: event.text },
        ]);
        return;
      case 'tool':
        setItems((current) => [
          ...current,
          {
            kind: 'tool',
            key: nextKey(),
            id: event.id,
            activity: toolActivity(event.name, event.input),
            state: 'running',
          },
        ]);
        return;
      case 'tool-result':
        setItems((current) =>
          current.map((item) =>
            item.kind === 'tool' && item.id === event.id && item.state === 'running'
              ? { ...item, state: event.isError ? 'failed' : 'done' }
              : item,
          ),
        );
        return;
      case 'usage':
        setUsage({ input: event.chatInputTokens, output: event.chatOutputTokens });
        return;
      case 'error':
        setItems((current) => [
          ...current,
          { kind: 'error', key: nextKey(), code: event.code, message: event.message },
        ]);
        return;
      case 'done': {
        const notice =
          event.stopped === 'step-limit'
            ? t`The assistant stopped after many steps. Say “continue” to let it go on.`
            : event.stopped === 'max-tokens'
              ? t`The answer was cut off because it got too long. Say “continue” for the rest.`
              : event.stopped === 'context-full'
                ? t`This chat is too long for the model. Start a new chat to go on.`
                : event.stopped === 'aborted'
                  ? t`Stopped.`
                  : null;
        if (notice !== null) {
          setItems((current) => [...current, { kind: 'notice', key: nextKey(), text: notice }]);
        }
        setItems((current) =>
          current.map((item) =>
            item.kind === 'tool' && item.state === 'running' ? { ...item, state: 'failed' } : item,
          ),
        );
        return;
      }
    }
  }

  async function send(queued?: string) {
    const message = (queued ?? text).trim();
    if (message === '' || sending || selection === null) return;
    if (queued === undefined) setText('');
    if (inputRef.current !== null) inputRef.current.style.height = 'auto';
    setItems((current) => [
      ...current,
      { kind: 'user', key: nextKey(), text: message, page: currentDoc ?? undefined },
    ]);
    setSending(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    const failure = await sendChatMessage(
      {
        chatId,
        text: message,
        provider: selection.provider,
        model: selection.model,
        page: currentDoc,
        signal: controller.signal,
      },
      handleEvent,
    ).then(
      () => null,
      (err: unknown) => err ?? new Error('failed'),
    );
    controllerRef.current = null;
    setSending(false);
    refreshChats();
    setItems((current) =>
      current.map((item) =>
        item.kind === 'tool' && item.state === 'running' ? { ...item, state: 'failed' } : item,
      ),
    );
    if (failure === null) return;
    if (controller.signal.aborted) {
      setItems((current) => [...current, { kind: 'notice', key: nextKey(), text: t`Stopped.` }]);
      return;
    }
    setItems((current) => [
      ...current,
      {
        kind: 'error',
        key: nextKey(),
        code: failure instanceof ChatApiError ? failure.code : 'network',
        message: failure instanceof Error ? failure.message : String(failure),
      },
    ]);
  }

  const takeQueuedRequest = useEffectEvent(() => {
    if (overview === null || sending) return;
    const queued = takeChatRequest();
    if (queued === null) return;
    if (selection === null) {
      setText(queued);
      return;
    }
    void send(queued);
  });

  useEffect(() => onChatRequest(() => takeQueuedRequest()), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a request queued while the chat loads or answers is sent once it is ready
  useEffect(() => {
    takeQueuedRequest();
  }, [overview, selection, sending]);

  const usableProviders = overview?.providers.filter((provider) => provider.key.configured) ?? [];
  const providerLabel =
    overview?.providers.find((provider) => provider.id === selection?.provider)?.label ?? '';

  if (overview === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground text-sm">
        {loadFailed ? t`The AI chat could not be loaded.` : t`Loading…`}
      </div>
    );
  }

  if (usableProviders.length === 0) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        data-testid="ai-chat-setup"
      >
        <p className="font-medium text-sm">{t`Chat with Claude or Mistral about the wiki`}</p>
        <p className="max-w-xs text-muted-foreground text-sm">
          <Trans>
            The assistant can search and read pages and change them when you ask. Add your own API
            key to start; you pay the provider for what you use.
          </Trans>
        </p>
        <Button size="sm" onClick={() => openAiChatSettings()}>
          {t`Add an API key`}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-chat-panel">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <p className="min-w-0 flex-1 truncate ps-1 font-medium text-sm" title={title ?? undefined}>
          {title ?? t`New chat`}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`New chat`}
          onClick={startNewChat}
          disabled={sending}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
        <DropdownMenu onOpenChange={(open) => open && refreshChats()}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t`Earlier chats`} disabled={sending}>
              <History aria-hidden="true" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>
              {t`Your chats (kept ${overview.retentionDays} days)`}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {chats.length === 0 ? (
              <p className="px-2 py-1.5 text-muted-foreground text-sm">{t`No chats yet.`}</p>
            ) : (
              chats.map((chat) => (
                <DropdownMenuItem
                  key={chat.id}
                  className="flex items-center gap-2"
                  onSelect={() => void openChat(chat.id)}
                >
                  {chat.id === chatId ? <Check aria-hidden="true" className="size-3.5" /> : null}
                  <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {new Date(chat.updatedAt).toLocaleDateString()}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`More chat actions`}
              disabled={chatId === null || sending}
            >
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={async () => {
                if (chatId === null) return;
                try {
                  setSuggestedPath((await fetchChat(chatId)).suggestedPath);
                } catch {}
                setSaveOpen(true);
              }}
            >
              <FilePlus2 aria-hidden="true" className="size-4" />
              {t`Save as page…`}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2 aria-hidden="true" className="size-4" />
              {t`Delete chat…`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
        aria-live="polite"
        data-testid="ai-chat-messages"
      >
        {items.length === 0 ? (
          <p className="pt-6 text-center text-muted-foreground text-sm">
            {currentDoc === null
              ? t`Ask anything about the wiki.`
              : t`Ask about this page or anything in the wiki.`}
          </p>
        ) : null}
        {items.map((item) => {
          switch (item.kind) {
            case 'user':
              return (
                <div
                  key={item.key}
                  className="ms-6 rounded-lg bg-muted px-3 py-2"
                  data-testid="ai-chat-user"
                >
                  <ChatPlainText text={item.text} />
                </div>
              );
            case 'assistant':
              return (
                <div key={item.key} data-testid="ai-chat-assistant">
                  <ChatMarkdown text={item.text} />
                </div>
              );
            case 'tool':
              return <ToolLine key={item.key} item={item} />;
            case 'error':
              return <ErrorLine key={item.key} item={item} />;
            default:
              return (
                <p key={item.key} className="text-muted-foreground text-xs italic">
                  {item.text}
                </p>
              );
          }
        })}
        {sending ? (
          <p className="text-muted-foreground text-xs" data-testid="ai-chat-thinking">
            {t`Thinking…`}
          </p>
        ) : null}
      </div>
      <form
        className="space-y-1.5 border-t p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border bg-card px-2 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <Textarea
            ref={inputRef}
            rows={1}
            value={text}
            aria-label={t`Message`}
            placeholder={
              currentDoc === null ? t`Ask about the wiki` : t`Ask about this page or the wiki`
            }
            onChange={(event) => {
              setText(event.target.value);
              event.target.style.height = 'auto';
              event.target.style.height = `${Math.min(event.target.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            className="max-h-[200px] min-h-8 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          {sending ? (
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={t`Stop`}
              onClick={() => controllerRef.current?.abort()}
              className="mb-1"
            >
              <Square aria-hidden="true" className="size-3.5" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-sm"
              aria-label={t`Send`}
              disabled={text.trim() === ''}
              className="mb-1"
            >
              <ArrowUp aria-hidden="true" className="size-4" />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={selection === null ? undefined : `${selection.provider}:${selection.model}`}
            onValueChange={(value) => {
              const [provider, ...rest] = value.split(':');
              if (provider !== 'claude' && provider !== 'mistral') return;
              const next = { provider, model: rest.join(':') } as Selection;
              setSelection(next);
              storeSelection(next);
            }}
            disabled={sending}
          >
            <SelectTrigger
              size="sm"
              className="h-7 min-w-0 max-w-[60%] text-xs"
              aria-label={t`Model`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {usableProviders.map((provider) => (
                <SelectGroup key={provider.id}>
                  <SelectLabel>{provider.label}</SelectLabel>
                  {provider.models.map((model) => (
                    <SelectItem key={model.id} value={`${provider.id}:${model.id}`}>
                      {model.label}
                      <span className="ms-1 text-muted-foreground">
                        ·{' '}
                        {model.tier === 'capable'
                          ? t`Most capable, costs more`
                          : model.tier === 'fast'
                            ? t`Fastest, cheapest`
                            : t`Balanced`}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <p
            className="min-w-0 flex-1 truncate text-end text-muted-foreground text-xs"
            title={t`Tokens sent and received in this chat, billed to your ${providerLabel} key`}
            data-testid="ai-chat-usage"
          >
            {usage.input + usage.output === 0
              ? t`Your ${providerLabel} key`
              : t`${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out`}
          </p>
        </div>
      </form>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Delete this chat?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`The conversation is removed from the server. Pages the assistant changed stay as they are.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (chatId !== null) void removeChat(chatId);
              }}
            >
              {t`Delete`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SaveAsPageDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        suggestedPath={suggestedPath}
        onSave={async (path) => {
          if (chatId === null) return;
          const saved = await saveChatAsPage(chatId, path);
          toast.success(t`Saved as ${saved}.`, {
            action: {
              label: t`Open`,
              onClick: () => window.location.assign(hashFromDocName(saved)),
            },
          });
        }}
      />
    </div>
  );
}
