import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatOverview, ChatUsageReport } from '@/lib/gitquire/chat-api';
import { AiChatSettings } from './AiChatSettings';

const overview: ChatOverview = {
  available: true,
  retentionDays: 90,
  providers: [
    {
      id: 'claude',
      label: 'Claude (Anthropic)',
      models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'balanced' }],
      defaultModel: 'claude-sonnet-5-5',
      keyUrl: 'https://example.com/keys',
      limitsUrl: 'https://example.com/limits',
      key: { configured: true, hint: '…1234', savedAt: null },
    },
  ],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function stub(usage: ChatUsageReport) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/gitquire/chat') return json(overview);
      if (url === '/api/gitquire/chat/usage') return json(usage);
      return new Response('{}', { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('token usage in Settings → AI chat', () => {
  test('shows the total, the days and the chats', async () => {
    stub({
      retentionDays: 90,
      total: { inputTokens: 125_000, outputTokens: 2_300 },
      days: [
        { day: '2026-11-16', inputTokens: 25_000, outputTokens: 300 },
        { day: '2026-11-15', inputTokens: 100_000, outputTokens: 2_000 },
      ],
      chats: [
        {
          chatId: 'aaaaaaaaaaaaaaaa',
          title: 'Plan the offsite',
          provider: 'claude',
          model: 'claude-sonnet-5-5',
          lastDay: '2026-11-16',
          inputTokens: 125_000,
          outputTokens: 2_300,
        },
      ],
    });
    render(<AiChatSettings />);
    const total = await screen.findByTestId('ai-chat-usage-total');
    expect(total.textContent).toContain('Last 90 days: 125k tokens in, 2.3k out.');
    const days = screen.getByRole('table', { name: 'Day' });
    expect(within(days).getAllByRole('row')).toHaveLength(3);
    expect(within(days).getByText('2026-11-15')).toBeTruthy();
    const chats = screen.getByRole('table', { name: 'Chat' });
    expect(within(chats).getByText('Plan the offsite')).toBeTruthy();
    expect(within(chats).getByText('claude-sonnet-5-5 · 2026-11-16')).toBeTruthy();
  });

  test('says so when nothing was used', async () => {
    stub({ retentionDays: 90, total: { inputTokens: 0, outputTokens: 0 }, days: [], chats: [] });
    render(<AiChatSettings />);
    expect(await screen.findByText('No tokens used in the last 90 days.')).toBeTruthy();
  });
});
