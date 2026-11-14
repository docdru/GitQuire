import type { SessionUser } from '../access-gate.ts';
import type { ChatMessage, ChatRecord, ToolResult } from './history.ts';
import { type ChatProviders, ProviderError, type ProviderErrorCode } from './providers.ts';
import type { WikiTools } from './wiki-tools.ts';

export const MAX_TOOL_STEPS = 12;
export const MAX_REPLY_TOKENS = 4096;
const PREVIEW_CHARS = 400;

export type ChatEvent =
  | { type: 'chat'; id: string; title: string; provider: string; model: string }
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
  | { type: 'error'; code: ProviderErrorCode | 'tools-unavailable'; message: string }
  | { type: 'done'; stopped: 'end' | 'step-limit' | 'max-tokens' | 'aborted' | 'error' };

export function systemPrompt(options: {
  user: SessionUser;
  wikiName: string;
  today: string;
}): string {
  const { user } = options;
  return [
    `You are an assistant inside GitQuire, the team wiki "${options.wikiName}". The wiki is a folder of Markdown pages kept in Git.`,
    `You are chatting with ${user.name} (GitHub @${user.login}). Every change you make is saved as their edit and credited to them, so only change pages when they ask you to.`,
    `Today is ${options.today}.`,
    'Use the tools to look things up instead of guessing: search to find pages, exec with cat/ls/grep to read them, links and history for context.',
    'Before changing a page, read it. Prefer edit (find and replace) for small changes and write for new pages. Keep the existing structure, style and language of a page.',
    'Pages may end with open comment threads; treat them as requests from the team and mention relevant ones.',
    'You cannot delete pages, change settings, install anything or run commands other than the read-only exec.',
    'Answer in the language the person writes in. Be brief. After changing pages, say which pages you changed and link them as [[page name]].',
  ].join('\n');
}

function preview(text: string): string {
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`;
}

export async function runChatTurn(options: {
  chat: ChatRecord;
  apiKey: string;
  providers: ChatProviders;
  tools: WikiTools;
  system: string;
  emit: (event: ChatEvent) => void;
  persist: (chat: ChatRecord) => void;
  now?: () => Date;
  signal?: AbortSignal;
  maxSteps?: number;
}): Promise<ChatEvent & { type: 'done' }> {
  const { chat, emit, signal } = options;
  const now = options.now ?? (() => new Date());
  const maxSteps = options.maxSteps ?? MAX_TOOL_STEPS;
  const append = (message: ChatMessage) => {
    chat.messages.push(message);
    chat.updatedAt = message.at;
    options.persist(chat);
  };
  const finish = (stopped: (ChatEvent & { type: 'done' })['stopped']) => {
    const done = { type: 'done' as const, stopped };
    emit(done);
    return done;
  };

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) return finish('aborted');
    let turn: Awaited<ReturnType<ChatProviders['turn']>>;
    try {
      turn = await options.providers.turn(chat.provider, options.apiKey, {
        model: chat.model,
        system: options.system,
        messages: chat.messages,
        tools: options.tools.specs,
        maxTokens: MAX_REPLY_TOKENS,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return finish('aborted');
      const failure =
        err instanceof ProviderError
          ? err
          : new ProviderError('unexpected', err instanceof Error ? err.message : String(err));
      emit({ type: 'error', code: failure.code, message: failure.message });
      return finish('error');
    }
    chat.usage.inputTokens += turn.usage.inputTokens;
    chat.usage.outputTokens += turn.usage.outputTokens;
    emit({
      type: 'usage',
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      chatInputTokens: chat.usage.inputTokens,
      chatOutputTokens: chat.usage.outputTokens,
    });
    if (turn.text !== '') emit({ type: 'text', text: turn.text });
    append({
      role: 'assistant',
      text: turn.text,
      toolCalls: turn.toolCalls,
      at: now().toISOString(),
    });
    if (turn.toolCalls.length === 0) {
      return finish(turn.stopReason === 'max_tokens' ? 'max-tokens' : 'end');
    }
    const results: ToolResult[] = [];
    for (const call of turn.toolCalls) {
      if (signal?.aborted) break;
      emit({ type: 'tool', id: call.id, name: call.name, input: call.input });
      const result = await options.tools.call(call.name, call.input).catch((err: unknown) => {
        if (signal?.aborted) throw err;
        return { output: err instanceof Error ? err.message : String(err), isError: true };
      });
      results.push({ id: call.id, name: call.name, ...result });
      emit({
        type: 'tool-result',
        id: call.id,
        name: call.name,
        isError: result.isError,
        preview: preview(result.output),
      });
    }
    for (const call of turn.toolCalls.slice(results.length)) {
      results.push({
        id: call.id,
        name: call.name,
        output: 'Stopped by the person.',
        isError: true,
      });
    }
    append({ role: 'tool', results, at: now().toISOString() });
    if (signal?.aborted) return finish('aborted');
  }
  return finish('step-limit');
}
