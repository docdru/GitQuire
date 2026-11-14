import { createHash } from 'node:crypto';
import type { ChatMessage, ChatUsage, ToolCall } from './history.ts';
import type { ChatProvider } from './models.ts';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderTurnRequest {
  model: string;
  system: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'context_full' | 'other';

export interface ProviderTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: ChatUsage;
  stopReason: StopReason;
  claudeContent?: unknown[];
}

export type ProviderErrorCode =
  | 'context-too-long'
  | 'invalid-key'
  | 'no-credit'
  | 'spend-limit'
  | 'rate-limited'
  | 'overloaded'
  | 'model-unavailable'
  | 'bad-request'
  | 'network'
  | 'unexpected';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | undefined;
  constructor(code: ProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

export type Fetch = typeof fetch;

export interface ProviderEndpoints {
  anthropic: string;
  mistral: string;
}

export const DEFAULT_ENDPOINTS: ProviderEndpoints = {
  anthropic: 'https://api.anthropic.com',
  mistral: 'https://api.mistral.ai',
};

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_ERROR_DETAIL = 300;

function pageNote(page: string | undefined): string {
  return page === undefined ? '' : `[I am looking at the page "${page}".]\n\n`;
}

function errorDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const record = body as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === 'object' && nested !== null) {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === 'string') return message.slice(0, MAX_ERROR_DETAIL);
  }
  for (const key of ['message', 'detail']) {
    const value = record[key];
    if (typeof value === 'string') return value.slice(0, MAX_ERROR_DETAIL);
  }
  return '';
}

export function classifyProviderFailure(status: number, detail: string): ProviderErrorCode {
  const text = detail.toLowerCase();
  if (status === 401) return 'invalid-key';
  if (
    /prompt is too long|context (length|window)|too many tokens|maximum context/.test(text) &&
    status >= 400 &&
    status < 500
  ) {
    return 'context-too-long';
  }
  if (text.includes('credit balance') || text.includes('insufficient') || status === 402) {
    return 'no-credit';
  }
  if (
    text.includes('spend limit') ||
    text.includes('spending limit') ||
    text.includes('usage limit')
  ) {
    return 'spend-limit';
  }
  if (status === 429) return 'rate-limited';
  if (status === 529 || status === 503 || status === 502) return 'overloaded';
  if (
    status === 404 ||
    (text.includes('model') && /not found|does not exist|invalid model|unknown model/.test(text))
  ) {
    return 'model-unavailable';
  }
  if (status === 403) return 'invalid-key';
  if (status >= 400 && status < 500) return 'bad-request';
  return 'unexpected';
}

async function postJson(
  doFetch: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ProviderError('network', 'The AI provider could not be reached.');
  }
  const parsed: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = errorDetail(parsed);
    throw new ProviderError(
      classifyProviderFailure(response.status, detail),
      detail || `The AI provider answered with HTTP ${response.status}.`,
      response.status,
    );
  }
  return parsed;
}

function mergeAdjacent<T extends { role: string; content: unknown[] }>(messages: T[]): T[] {
  const out: T[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (last !== undefined && last.role === message.role) {
      last.content.push(...message.content);
    } else {
      out.push({ ...message, content: [...message.content] });
    }
  }
  return out;
}

function withCacheBreakpoint(messages: unknown[]): unknown[] {
  const last = messages.at(-1) as { role: string; content: Record<string, unknown>[] } | undefined;
  if (last === undefined || last.content.length === 0) return messages;
  const blocks = [...last.content];
  const tail = blocks.at(-1) as Record<string, unknown>;
  if (tail.type === 'thinking' || tail.type === 'redacted_thinking') return messages;
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

export function toAnthropicMessages(messages: readonly ChatMessage[]): unknown[] {
  const converted: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      converted.push({
        role: 'user',
        content: [{ type: 'text', text: `${pageNote(message.page)}${message.text}` }],
      });
    } else if (message.role === 'assistant') {
      if (message.claudeContent !== undefined && message.claudeContent.length > 0) {
        converted.push({ role: 'assistant', content: [...message.claudeContent] });
        continue;
      }
      const content: unknown[] = [];
      if (message.text.trim() !== '') content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: anthropicToolId(call.id),
          name: call.name,
          input: call.input,
        });
      }
      if (content.length > 0) converted.push({ role: 'assistant', content });
    } else {
      converted.push({
        role: 'user',
        content: message.results.map((result) => ({
          type: 'tool_result',
          tool_use_id: anthropicToolId(result.id),
          content: result.output,
          ...(result.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return mergeAdjacent(converted);
}

function anthropicToolId(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : `t_${shortHash(id, 24)}`;
}

function shortHash(value: string, length: number): string {
  return createHash('sha256')
    .update(value)
    .digest('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, length);
}

export function mistralToolId(id: string): string {
  return /^[A-Za-z0-9]{9}$/.test(id) ? id : shortHash(id, 9);
}

export function toMistralMessages(system: string, messages: readonly ChatMessage[]): unknown[] {
  const out: { role: string }[] = [{ role: 'system', content: system } as { role: string }];
  for (const message of messages) {
    if (message.role === 'user') {
      if (out.at(-1)?.role === 'tool')
        out.push({ role: 'assistant', content: '…' } as { role: string });
      out.push({ role: 'user', content: `${pageNote(message.page)}${message.text}` } as {
        role: string;
      });
    } else if (message.role === 'assistant') {
      if (message.text.trim() === '' && message.toolCalls.length === 0) continue;
      out.push({
        role: 'assistant',
        content: message.text,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: mistralToolId(call.id),
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      } as { role: string });
    } else {
      for (const result of message.results) {
        out.push({
          role: 'tool',
          tool_call_id: mistralToolId(result.id),
          name: result.name,
          content: result.isError ? `Error: ${result.output}` : result.output,
        } as { role: string });
      }
    }
  }
  return out;
}

function parseInput(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return {};
}

async function anthropicTurn(
  doFetch: Fetch,
  base: string,
  apiKey: string,
  request: ProviderTurnRequest,
): Promise<ProviderTurn> {
  const tools = request.tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(index === request.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
  const body = await postJson(
    doFetch,
    `${base}/v1/messages`,
    { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    {
      model: request.model,
      max_tokens: request.maxTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: withCacheBreakpoint(toAnthropicMessages(request.messages)),
      ...(tools.length > 0 ? { tools } : {}),
    },
    request.signal,
  );
  const record = (body ?? {}) as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      toolCalls.push({ id: block.id, name: block.name, input: parseInput(block.input) });
    }
  }
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === 'number' ? value : 0);
  const stop = record.stop_reason;
  return {
    text,
    toolCalls,
    claudeContent: content,
    usage: {
      inputTokens:
        number(usage.input_tokens) +
        number(usage.cache_creation_input_tokens) +
        number(usage.cache_read_input_tokens),
      outputTokens: number(usage.output_tokens),
    },
    stopReason:
      stop === 'tool_use'
        ? 'tool_use'
        : stop === 'max_tokens'
          ? 'max_tokens'
          : stop === 'model_context_window_exceeded'
            ? 'context_full'
            : stop === 'end_turn' || stop === 'stop_sequence'
              ? 'end'
              : 'other',
  };
}

async function mistralTurn(
  doFetch: Fetch,
  base: string,
  apiKey: string,
  request: ProviderTurnRequest,
): Promise<ProviderTurn> {
  const body = await postJson(
    doFetch,
    `${base}/v1/chat/completions`,
    { authorization: `Bearer ${apiKey}` },
    {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: toMistralMessages(request.system, request.messages),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            tool_choice: 'auto',
          }
        : {}),
    },
    request.signal,
  );
  const record = (body ?? {}) as Record<string, unknown>;
  const choice = (Array.isArray(record.choices) ? record.choices[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  const message = (choice?.message ?? {}) as Record<string, unknown>;
  const content = message.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const part of content as Record<string, unknown>[]) {
      if (part.type === 'text' && typeof part.text === 'string') text += part.text;
    }
  }
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls as Record<string, unknown>[]) {
      const fn = (call.function ?? {}) as Record<string, unknown>;
      if (typeof call.id !== 'string' || typeof fn.name !== 'string') continue;
      toolCalls.push({ id: call.id, name: fn.name, input: parseInput(fn.arguments) });
    }
  }
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === 'number' ? value : 0);
  const finish = choice?.finish_reason;
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: number(usage.prompt_tokens),
      outputTokens: number(usage.completion_tokens),
    },
    stopReason:
      toolCalls.length > 0 || finish === 'tool_calls'
        ? 'tool_use'
        : finish === 'length'
          ? 'max_tokens'
          : finish === 'stop'
            ? 'end'
            : 'other',
  };
}

export interface ChatProviders {
  turn(provider: ChatProvider, apiKey: string, request: ProviderTurnRequest): Promise<ProviderTurn>;
  checkKey(provider: ChatProvider, apiKey: string): Promise<void>;
}

export function createChatProviders(
  options: { fetch?: Fetch; endpoints?: Partial<ProviderEndpoints> } = {},
): ChatProviders {
  const doFetch = options.fetch ?? fetch;
  const endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
  return {
    turn(provider, apiKey, request) {
      return provider === 'claude'
        ? anthropicTurn(doFetch, endpoints.anthropic, apiKey, request)
        : mistralTurn(doFetch, endpoints.mistral, apiKey, request);
    },
    async checkKey(provider, apiKey) {
      const url =
        provider === 'claude'
          ? `${endpoints.anthropic}/v1/models`
          : `${endpoints.mistral}/v1/models`;
      const headers: Record<string, string> =
        provider === 'claude'
          ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
          : { authorization: `Bearer ${apiKey}` };
      let response: Response;
      try {
        response = await doFetch(url, { headers });
      } catch {
        throw new ProviderError('network', 'The AI provider could not be reached.');
      }
      if (response.ok) return;
      const detail = errorDetail(await response.json().catch(() => undefined));
      throw new ProviderError(
        classifyProviderFailure(response.status, detail),
        detail || `The AI provider answered with HTTP ${response.status}.`,
        response.status,
      );
    },
  };
}
