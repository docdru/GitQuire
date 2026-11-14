import { describe, expect, it } from 'vitest';
import { type ChatEvent, runChatTurn, systemPrompt } from './agent.ts';
import type { ChatMessage, ChatRecord } from './history.ts';
import {
  classifyProviderFailure,
  createChatProviders,
  mistralToolId,
  ProviderError,
  type ProviderTurn,
  toAnthropicMessages,
  toMistralMessages,
} from './providers.ts';
import { chatTranscript, normalizePagePath, suggestedPagePath } from './transcript.ts';
import { refusedArguments, truncateOutput, type WikiTools } from './wiki-tools.ts';

const USER = { id: 7, login: 'alice', name: 'Alice', avatarUrl: '' };
const AT = '2026-11-14T09:00:00.000Z';

const conversation: ChatMessage[] = [
  { role: 'user', text: 'Fix the typo', page: 'notes/plan', at: AT },
  {
    role: 'assistant',
    text: 'Reading it.',
    toolCalls: [{ id: 'toolu_01', name: 'exec', input: { command: 'cat notes/plan.md' } }],
    at: AT,
  },
  {
    role: 'tool',
    results: [{ id: 'toolu_01', name: 'exec', output: '# Plan', isError: false }],
    at: AT,
  },
  { role: 'assistant', text: 'Done.', toolCalls: [], at: AT },
  { role: 'user', text: 'Thanks', at: AT },
];

function chatRecord(provider: 'claude' | 'mistral' = 'claude'): ChatRecord {
  return {
    id: 'abcdefghijklmnop',
    title: 'Fix the typo',
    provider,
    model: provider === 'claude' ? 'claude-sonnet-5-5' : 'mistral-medium-latest',
    createdAt: AT,
    updatedAt: AT,
    messages: [{ role: 'user', text: 'Fix the typo', at: AT }],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('provider message formats', () => {
  it('builds Anthropic messages with tool_use and tool_result blocks', () => {
    const messages = toAnthropicMessages(conversation) as {
      role: string;
      content: Record<string, unknown>[];
    }[];
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[0]?.content[0]?.text).toContain('[I am looking at the page "notes/plan".]');
    expect(messages[1]?.content[1]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_01',
      name: 'exec',
    });
    expect(messages[2]?.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_01' });
  });

  it('builds Mistral messages with nine-character tool call ids', () => {
    const messages = toMistralMessages('system text', conversation) as Record<string, unknown>[];
    expect(messages[0]).toEqual({ role: 'system', content: 'system text' });
    const call = (messages[2]?.tool_calls as Record<string, unknown>[] | undefined)?.[0];
    expect(call?.id).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: call?.id, name: 'exec' });
    expect(mistralToolId('abcDEF123')).toBe('abcDEF123');
  });

  it('classifies provider failures', () => {
    expect(classifyProviderFailure(401, '')).toBe('invalid-key');
    expect(classifyProviderFailure(400, 'Your credit balance is too low')).toBe('no-credit');
    expect(classifyProviderFailure(429, 'You have reached your monthly spend limit')).toBe(
      'spend-limit',
    );
    expect(classifyProviderFailure(429, 'slow down')).toBe('rate-limited');
    expect(classifyProviderFailure(529, 'Overloaded')).toBe('overloaded');
    expect(classifyProviderFailure(404, 'model: x not found')).toBe('model-unavailable');
    expect(classifyProviderFailure(400, 'max_tokens: must be positive')).toBe('bad-request');
  });
});

describe('provider calls', () => {
  it('calls the Messages API and reads text, tool calls and usage', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const providers = createChatProviders({
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return jsonResponse(200, {
          content: [
            { type: 'text', text: 'Let me look.' },
            { type: 'tool_use', id: 'toolu_9', name: 'search', input: { query: 'plan' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
        });
      }) as typeof fetch,
    });
    const turn = await providers.turn('claude', 'sk-ant-key', {
      model: 'claude-sonnet-5-5',
      system: 'sys',
      messages: conversation,
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      maxTokens: 1000,
    });
    expect(seen?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-key');
    const body = JSON.parse(String(seen?.init.body));
    expect(body.tools[0]).toMatchObject({ name: 'search', input_schema: { type: 'object' } });
    expect(turn).toEqual({
      text: 'Let me look.',
      toolCalls: [{ id: 'toolu_9', name: 'search', input: { query: 'plan' } }],
      usage: { inputTokens: 120, outputTokens: 30 },
      stopReason: 'tool_use',
    });
  });

  it('calls Mistral chat completions and parses JSON tool arguments', async () => {
    let seenUrl = '';
    const providers = createChatProviders({
      fetch: (async (url: string) => {
        seenUrl = url;
        return jsonResponse(200, {
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { id: 'aB3dE5gH9', function: { name: 'search', arguments: '{"query":"x"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        });
      }) as typeof fetch,
    });
    const turn = await providers.turn('mistral', 'key', {
      model: 'mistral-medium-latest',
      system: 's',
      messages: conversation,
      tools: [],
      maxTokens: 100,
    });
    expect(seenUrl).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(turn.toolCalls).toEqual([{ id: 'aB3dE5gH9', name: 'search', input: { query: 'x' } }]);
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
  });

  it('turns HTTP errors into provider errors with the provider’s message', async () => {
    const providers = createChatProviders({
      fetch: (async () =>
        jsonResponse(400, {
          error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' },
        })) as unknown as typeof fetch,
    });
    await expect(
      providers.turn('claude', 'k', {
        model: 'm',
        system: 's',
        messages: [],
        tools: [],
        maxTokens: 1,
      }),
    ).rejects.toMatchObject({ code: 'no-credit', message: 'Your credit balance is too low.' });
    await expect(providers.checkKey('mistral', 'k')).rejects.toBeInstanceOf(ProviderError);
  });
});

function scriptedProviders(turns: ProviderTurn[]) {
  const requests: unknown[] = [];
  return {
    requests,
    providers: {
      async turn(_provider: string, _key: string, request: unknown) {
        requests.push(structuredClone(request));
        const next = turns.shift();
        if (next === undefined) throw new Error('no more turns');
        return next;
      },
      async checkKey() {},
    },
  };
}

function fakeTools(): WikiTools & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    specs: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
    async call(name, input) {
      calls.push(`${name}:${JSON.stringify(input)}`);
      return { output: `result of ${name}`, isError: false };
    },
    async close() {},
  };
}

describe('the chat loop', () => {
  it('runs tools until the model answers, saving each step', async () => {
    const chat = chatRecord();
    const { providers, requests } = scriptedProviders([
      {
        text: '',
        toolCalls: [{ id: 't1', name: 'search', input: { query: 'typo' } }],
        usage: { inputTokens: 10, outputTokens: 2 },
        stopReason: 'tool_use',
      },
      {
        text: 'Fixed it.',
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 3 },
        stopReason: 'end',
      },
    ]);
    const tools = fakeTools();
    const events: ChatEvent[] = [];
    let saves = 0;
    const done = await runChatTurn({
      chat,
      apiKey: 'k',
      providers,
      tools,
      system: 'sys',
      emit: (event) => events.push(event),
      persist: () => {
        saves += 1;
      },
    });
    expect(done.stopped).toBe('end');
    expect(tools.calls).toEqual(['search:{"query":"typo"}']);
    expect(chat.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(chat.usage).toEqual({ inputTokens: 30, outputTokens: 5 });
    expect(saves).toBe(3);
    expect(requests).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual([
      'usage',
      'tool',
      'tool-result',
      'usage',
      'text',
      'done',
    ]);
  });

  it('stops after the step limit', async () => {
    const loop: ProviderTurn = {
      text: '',
      toolCalls: [{ id: 't', name: 'search', input: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'tool_use',
    };
    const { providers } = scriptedProviders([loop, loop, loop]);
    const done = await runChatTurn({
      chat: chatRecord(),
      apiKey: 'k',
      providers,
      tools: fakeTools(),
      system: 's',
      emit: () => {},
      persist: () => {},
      maxSteps: 2,
    });
    expect(done.stopped).toBe('step-limit');
  });

  it('reports provider errors to the person', async () => {
    const events: ChatEvent[] = [];
    const done = await runChatTurn({
      chat: chatRecord(),
      apiKey: 'k',
      providers: {
        turn: async () => {
          throw new ProviderError('spend-limit', 'Monthly spend limit reached.', 429);
        },
        checkKey: async () => {},
      },
      tools: fakeTools(),
      system: 's',
      emit: (event) => events.push(event),
      persist: () => {},
    });
    expect(done.stopped).toBe('error');
    expect(events).toContainEqual({
      type: 'error',
      code: 'spend-limit',
      message: 'Monthly spend limit reached.',
    });
  });

  it('stops when the person closes the chat, recording unfinished tool calls', async () => {
    const controller = new AbortController();
    const chat = chatRecord();
    const { providers } = scriptedProviders([
      {
        text: '',
        toolCalls: [
          { id: 'a', name: 'search', input: {} },
          { id: 'b', name: 'search', input: {} },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_use',
      },
    ]);
    const tools = fakeTools();
    const original = tools.call;
    tools.call = async (name, input) => {
      const result = await original(name, input);
      controller.abort();
      return result;
    };
    const done = await runChatTurn({
      chat,
      apiKey: 'k',
      providers,
      tools,
      system: 's',
      emit: () => {},
      persist: () => {},
      signal: controller.signal,
    });
    expect(done.stopped).toBe('aborted');
    const last = chat.messages.at(-1);
    expect(last?.role).toBe('tool');
    expect(last?.role === 'tool' ? last.results.map((result) => result.isError) : []).toEqual([
      false,
      true,
    ]);
  });

  it('names the person and the wiki in the system prompt', () => {
    const text = systemPrompt({ user: USER, wikiName: 'acme/wiki', today: '2026-11-14' });
    expect(text).toContain('acme/wiki');
    expect(text).toContain('@alice');
    expect(text).toContain('2026-11-14');
  });
});

describe('wiki tool guards', () => {
  it('lets write and edit change pages and folders only', () => {
    expect(refusedArguments('write', { document: {} })).toBeUndefined();
    expect(refusedArguments('write', { skill: {} })).toContain('skill');
    expect(refusedArguments('edit', { template: {} })).toContain('template');
    expect(refusedArguments('search', { anything: 1 })).toBeUndefined();
  });

  it('shortens long tool output', () => {
    const long = 'x'.repeat(25_000);
    expect(truncateOutput(long)).toContain('output shortened: 5000 more characters');
  });
});

describe('saving a chat as a page', () => {
  it('writes a readable transcript', () => {
    const chat = chatRecord();
    chat.messages.push({
      role: 'assistant',
      text: 'Fixed the typo in [[notes/plan]].',
      toolCalls: [
        {
          id: 'x',
          name: 'edit',
          input: { document: { path: 'notes/plan', find: 'teh', replace: 'the' } },
        },
      ],
      at: AT,
    });
    const text = chatTranscript(chat, USER);
    expect(text).toContain('# Fix the typo');
    expect(text).toContain('AI chat between @alice and Claude Sonnet 5.5');
    expect(text).toContain('**@alice:**\n\n> Fix the typo');
    expect(text).toContain('**Claude Sonnet 5.5:**\n\nFixed the typo in [[notes/plan]].');
    expect(text).toContain('- *Used edit: `notes/plan`*');
  });

  it('suggests and checks page paths', () => {
    expect(suggestedPagePath(chatRecord())).toBe('AI chats/2026-11-14 Fix the typo');
    expect(normalizePagePath(' AI chats/Plan review.md ')).toBe('AI chats/Plan review');
    expect(() => normalizePagePath('../outside')).toThrow();
    expect(() => normalizePagePath('notes//x')).toThrow();
    expect(() => normalizePagePath('.ok/config')).toThrow();
    expect(() => normalizePagePath('a/b<c')).toThrow();
  });
});
