import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChatOverview } from '@/lib/gitquire/chat-api';
import { queueChatRequest } from '@/lib/gitquire/chat-requests';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatPanel, pickSelection } from './ChatPanel';

const openAiChatSettings = vi.fn();
vi.mock('@/lib/use-settings-route', () => ({ openAiChatSettings: () => openAiChatSettings() }));

function overview(configured: { claude?: boolean; mistral?: boolean }): ChatOverview {
  const key = (on: boolean | undefined) => ({
    configured: on === true,
    hint: on === true ? '…1234' : null,
    savedAt: null,
  });
  return {
    available: true,
    retentionDays: 90,
    providers: [
      {
        id: 'claude',
        label: 'Claude (Anthropic)',
        models: [
          { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Balanced' },
          { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest, cheapest' },
        ],
        defaultModel: 'claude-sonnet-5-5',
        keyUrl: 'https://example.com/keys',
        limitsUrl: 'https://example.com/limits',
        key: key(configured.claude),
      },
      {
        id: 'mistral',
        label: 'Mistral (La Plateforme)',
        models: [{ id: 'mistral-medium-latest', label: 'Mistral Medium', note: 'Balanced' }],
        defaultModel: 'mistral-medium-latest',
        keyUrl: 'https://example.com/keys',
        limitsUrl: 'https://example.com/limits',
        key: key(configured.mistral),
      },
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let requests: { url: string; init?: RequestInit }[] = [];

function stubFetch(routes: (url: string, init?: RequestInit) => Response | undefined) {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return routes(url, init) ?? json({ error: 'not-found' }, 404);
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/notes/plan';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  openAiChatSettings.mockReset();
});

describe('choosing a model', () => {
  test('keeps the stored choice while its key is saved', () => {
    expect(
      pickSelection(overview({ claude: true, mistral: true }), {
        provider: 'mistral',
        model: 'mistral-medium-latest',
      }),
    ).toEqual({ provider: 'mistral', model: 'mistral-medium-latest' });
  });

  test('falls back to the first provider with a key', () => {
    expect(pickSelection(overview({ claude: true }), { provider: 'mistral', model: 'x' })).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-5-5',
    });
    expect(pickSelection(overview({}), null)).toBeNull();
  });
});

describe('ChatPanel', () => {
  test('asks for an API key first', async () => {
    stubFetch((url) => {
      if (url === '/api/gitquire/chat') return json(overview({}));
      if (url === '/api/gitquire/chat/chats') return json({ chats: [] });
      return undefined;
    });
    render(<ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an API key' }));
    expect(openAiChatSettings).toHaveBeenCalled();
  });

  test('sends a message with the current page and shows the streamed answer', async () => {
    const stream = [
      {
        type: 'chat',
        id: 'abcdefghijklmnop',
        title: 'What is next?',
        provider: 'claude',
        model: 'claude-sonnet-5-5',
      },
      {
        type: 'usage',
        inputTokens: 1200,
        outputTokens: 30,
        chatInputTokens: 1200,
        chatOutputTokens: 30,
      },
      { type: 'tool', id: 't1', name: 'edit', input: { document: { path: 'notes/plan' } } },
      { type: 'tool-result', id: 't1', name: 'edit', isError: false, preview: 'ok' },
      { type: 'text', text: 'I updated **the plan** in [[notes/plan]].' },
      { type: 'done', stopped: 'end' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    stubFetch((url) => {
      if (url === '/api/gitquire/chat') return json(overview({ claude: true }));
      if (url === '/api/gitquire/chat/chats') return json({ chats: [] });
      if (url === '/api/gitquire/chat/chats/new/messages') {
        return new Response(`${stream}\n`, {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      return undefined;
    });
    render(<ChatPanel />);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'What is next?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('the plan')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'notes/plan' }).getAttribute('href')).toContain(
      'notes/plan',
    );
    expect(screen.getByTestId('ai-chat-tool').textContent).toContain('Edited notes/plan');
    await waitFor(() =>
      expect(screen.getByTestId('ai-chat-usage').textContent).toBe('1.2k in · 30 out'),
    );
    expect(screen.getByTestId('ai-chat-user').textContent).toBe('What is next?');

    const sent = requests.find((request) => request.url.endsWith('/messages'));
    expect(JSON.parse(String(sent?.init?.body))).toEqual({
      text: 'What is next?',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      page: 'notes/plan',
    });
  });

  test('sends a request queued from the Ask box once the chat is ready', async () => {
    stubFetch((url) => {
      if (url === '/api/gitquire/chat') return json(overview({ claude: true }));
      if (url === '/api/gitquire/chat/chats') return json({ chats: [] });
      if (url.endsWith('/messages')) {
        return new Response(
          `${JSON.stringify({ type: 'text', text: 'Sure.' })}\n${JSON.stringify({ type: 'done', stopped: 'end' })}\n`,
        );
      }
      return undefined;
    });
    queueChatRequest('Summarise this page');
    render(<ChatPanel />);
    expect(await screen.findByText('Sure.')).toBeTruthy();
    const sent = requests.find((request) => request.url.endsWith('/messages'));
    expect(JSON.parse(String(sent?.init?.body)).text).toBe('Summarise this page');
  });

  test('explains provider errors', async () => {
    stubFetch((url) => {
      if (url === '/api/gitquire/chat') return json(overview({ claude: true }));
      if (url === '/api/gitquire/chat/chats') return json({ chats: [] });
      if (url.endsWith('/messages')) {
        return new Response(
          `${JSON.stringify({ type: 'error', code: 'spend-limit', message: 'Monthly limit reached.' })}\n${JSON.stringify({ type: 'done', stopped: 'error' })}\n`,
        );
      }
      return undefined;
    });
    render(<ChatPanel />);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Hi' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('spending limit');
    expect(alert.textContent).toContain('Monthly limit reached.');
  });
});

describe('ChatMarkdown', () => {
  test('renders lists, code and links without HTML injection', () => {
    render(
      <ChatMarkdown
        text={
          'Changes:\n- one `code`\n- [site](https://example.com)\n\n<img src=x onerror=alert(1)>'
        }
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: 'site' }).getAttribute('target')).toBe('_blank');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  test('does not turn javascript: links into anchors', () => {
    render(<ChatMarkdown text="[click](javascript:alert(1))" />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
