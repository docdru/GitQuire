export type ChatProvider = 'claude' | 'mistral';

export type ModelTier = 'balanced' | 'capable' | 'fast';

export interface ChatModel {
  id: string;
  label: string;
  tier: ModelTier;
}

export interface ChatKeyInfo {
  configured: boolean;
  hint: string | null;
  savedAt: string | null;
  unreadable?: boolean;
}

export interface ChatProviderInfo {
  id: ChatProvider;
  label: string;
  models: ChatModel[];
  defaultModel: string;
  keyUrl: string;
  limitsUrl: string;
  key: ChatKeyInfo;
}

export interface ChatOverview {
  available: boolean;
  retentionDays: number;
  providers: ChatProviderInfo[];
}

export interface ChatSummary {
  id: string;
  title: string;
  provider: ChatProvider;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; text: string; page?: string; at: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; at: string }
  | {
      role: 'tool';
      results: { id: string; name: string; output: string; isError: boolean }[];
      at: string;
    };

export interface ChatRecord extends ChatSummary {
  messages: ChatMessage[];
  usage: { inputTokens: number; outputTokens: number };
}

export type ChatStopReason =
  | 'end'
  | 'step-limit'
  | 'max-tokens'
  | 'context-full'
  | 'aborted'
  | 'error';

export type ChatEvent =
  | { type: 'chat'; id: string; title: string; provider: ChatProvider; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; id: string; name: string; isError: boolean; preview: string }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      chatInputTokens: number;
      chatOutputTokens: number;
    }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; stopped: ChatStopReason };

export class ChatApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ChatApiError';
    this.status = status;
    this.code = code;
  }
}

const BASE = '/api/gitquire/chat';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ChatApiError(
      response.status,
      typeof body.error === 'string' ? body.error : 'failed',
      typeof body.message === 'string' ? body.message : `Request failed (${response.status}).`,
    );
  }
  return body as T;
}

export function fetchChatOverview(): Promise<ChatOverview> {
  return request<ChatOverview>('');
}

export async function saveChatKey(provider: ChatProvider, key: string): Promise<ChatKeyInfo> {
  const body = await request<{ key: ChatKeyInfo }>(`/keys/${provider}`, {
    method: 'PUT',
    body: JSON.stringify({ key }),
  });
  return body.key;
}

export async function removeChatKey(provider: ChatProvider): Promise<ChatKeyInfo> {
  const body = await request<{ key: ChatKeyInfo }>(`/keys/${provider}`, { method: 'DELETE' });
  return body.key;
}

export async function listChats(): Promise<ChatSummary[]> {
  return (await request<{ chats: ChatSummary[] }>('/chats')).chats;
}

export function fetchChat(id: string): Promise<{ chat: ChatRecord; suggestedPath: string }> {
  return request(`/chats/${encodeURIComponent(id)}`);
}

export async function deleteChat(id: string): Promise<void> {
  await request(`/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function saveChatAsPage(id: string, path: string): Promise<string> {
  const body = await request<{ path: string }>(`/chats/${encodeURIComponent(id)}/page`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
  return body.path;
}

export function parseChatEvents(buffer: string): { events: ChatEvent[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: ChatEvent[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as ChatEvent);
    } catch {}
  }
  return { events, rest };
}

export async function sendChatMessage(
  options: {
    chatId: string | null;
    text: string;
    provider: ChatProvider;
    model: string;
    page?: string | null;
    signal?: AbortSignal;
  },
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const response = await fetch(`${BASE}/chats/${options.chatId ?? 'new'}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: options.text,
      provider: options.provider,
      model: options.model,
      ...(options.page ? { page: options.page } : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok || response.body === null) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ChatApiError(
      response.status,
      typeof body.error === 'string' ? body.error : 'failed',
      typeof body.message === 'string' ? body.message : `Request failed (${response.status}).`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseChatEvents(buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) onEvent(event);
  }
  const tail = parseChatEvents(`${buffer}\n`);
  for (const event of tail.events) onEvent(event);
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 100_000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

export type ToolActivityKind =
  | 'search'
  | 'read'
  | 'write'
  | 'edit'
  | 'move'
  | 'links'
  | 'history'
  | 'lint'
  | 'other';

export interface ToolActivity {
  kind: ToolActivityKind;
  detail: string | null;
}

export function toolActivity(name: string, input: Record<string, unknown>): ToolActivity {
  const document = input.document as Record<string, unknown> | undefined;
  const path = typeof document?.path === 'string' ? document.path : null;
  switch (name) {
    case 'search':
      return { kind: 'search', detail: typeof input.query === 'string' ? input.query : null };
    case 'exec':
      return { kind: 'read', detail: typeof input.command === 'string' ? input.command : null };
    case 'write':
      return { kind: 'write', detail: path };
    case 'edit':
      return { kind: 'edit', detail: path };
    case 'move':
    case 'links':
    case 'history':
    case 'lint':
      return { kind: name, detail: null };
    default:
      return { kind: 'other', detail: name };
  }
}
