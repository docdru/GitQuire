import { describe, expect, it } from 'vitest';
import { createChatProviders, ProviderError } from './providers.ts';

function sse(events: Array<{ event?: string; data: unknown }>, chunkSize = 7): Response {
  const text = events
    .map(({ event, data }) => {
      const body = typeof data === 'string' ? data : JSON.stringify(data);
      return `${event === undefined ? '' : `event: ${event}\n`}data: ${body}\n\n`;
    })
    .join('');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunkSize) {
        controller.enqueue(bytes.slice(at, at + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const request = {
  model: 'm',
  system: 'sys',
  messages: [{ role: 'user' as const, text: 'hi', at: '2026-11-16T09:00:00.000Z' }],
  tools: [],
  maxTokens: 100,
};

function providersAnswering(response: () => Response, bodies: unknown[] = []) {
  return createChatProviders({
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return response();
    }) as unknown as typeof fetch,
  });
}

describe('streamed answers', () => {
  it('Claude: passes text on as it arrives and assembles text, tool calls and usage', async () => {
    const bodies: unknown[] = [];
    const providers = providersAnswering(
      () =>
        sse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Look' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ing.' },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"query":' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '"typo"}' },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 42 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      bodies,
    );
    const deltas: string[] = [];
    const turn = await providers.turn('claude', 'k', {
      ...request,
      onText: (delta) => deltas.push(delta),
    });
    expect((bodies[0] as { stream: boolean }).stream).toBe(true);
    expect(deltas).toEqual(['Look', 'ing.']);
    expect(turn.text).toBe('Looking.');
    expect(turn.toolCalls).toEqual([{ id: 'toolu_1', name: 'search', input: { query: 'typo' } }]);
    expect(turn.usage).toEqual({ inputTokens: 15, outputTokens: 42 });
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.claudeContent).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'typo' } },
    ]);
  });

  it('Claude: an error event in the stream becomes a provider error', async () => {
    const providers = providersAnswering(() =>
      sse([
        { event: 'message_start', data: { type: 'message_start', message: { usage: {} } } },
        {
          event: 'error',
          data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        },
      ]),
    );
    const failure = await providers.turn('claude', 'k', request).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).code).toBe('overloaded');
  });

  it('Mistral: passes text on, joins tool calls sent in pieces and reads usage from the last chunk', async () => {
    const bodies: unknown[] = [];
    const providers = providersAnswering(
      () =>
        sse([
          { data: { choices: [{ index: 0, delta: { role: 'assistant', content: 'Sure' } }] } },
          { data: { choices: [{ index: 0, delta: { content: ', one moment.' } }] } },
          {
            data: {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'abcDEF123',
                        function: { name: 'search', arguments: '{"query"' },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            data: {
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: ':"typo"}' } }] },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 30, completion_tokens: 9 },
            },
          },
          { data: '[DONE]' },
        ]),
      bodies,
    );
    const deltas: string[] = [];
    const turn = await providers.turn('mistral', 'k', {
      ...request,
      onText: (delta) => deltas.push(delta),
    });
    expect((bodies[0] as { stream: boolean }).stream).toBe(true);
    expect(deltas).toEqual(['Sure', ', one moment.']);
    expect(turn.text).toBe('Sure, one moment.');
    expect(turn.toolCalls).toEqual([{ id: 'abcDEF123', name: 'search', input: { query: 'typo' } }]);
    expect(turn.usage).toEqual({ inputTokens: 30, outputTokens: 9 });
    expect(turn.stopReason).toBe('tool_use');
  });

  it('stops reading when the person presses stop', async () => {
    const controller = new AbortController();
    let pull = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pull += 1;
        if (pull === 1) {
          ctrl.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hel' } }] })}\n\n`,
            ),
          );
          return;
        }
        return new Promise(() => {});
      },
    });
    const providers = createChatProviders({
      fetch: (async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    const turn = providers.turn('mistral', 'k', {
      ...request,
      signal: controller.signal,
      onText: (delta) => {
        deltas.push(delta);
        controller.abort();
      },
    });
    await expect(turn).rejects.toBeDefined();
    expect(deltas).toEqual(['Hel']);
  });

  it('a gateway that answers with plain JSON still works and passes the whole text on once', async () => {
    const providers = providersAnswering(
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'All at once.' }],
            usage: { input_tokens: 3, output_tokens: 4 },
            stop_reason: 'end_turn',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const deltas: string[] = [];
    const turn = await providers.turn('claude', 'k', { ...request, onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(['All at once.']);
    expect(turn.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });
});
