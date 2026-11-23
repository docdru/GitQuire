import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChatOverview } from '@/lib/gitquire/chat-api';

vi.mock('@/lib/gitquire/drafts-store', () => ({
  useDraftState: () => ({
    loaded: true,
    list: { enabled: true, me: 'alice', viewing: null, drafts: [] },
    current: { viewing: null, drift: null, closed: null },
  }),
}));

vi.mock('@/lib/gitquire/drafts-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gitquire/drafts-api')>()),
  fetchAgentMode: async () => 'live',
}));

const overview: ChatOverview = {
  available: true,
  retentionDays: 90,
  providers: [
    {
      id: 'claude',
      label: 'Claude (Anthropic)',
      models: [
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'balanced' },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'fast' },
      ],
      defaultModel: 'claude-sonnet-5-5',
      keyUrl: 'https://example.com/keys',
      limitsUrl: 'https://example.com/limits',
      key: { configured: true, hint: '…1234', savedAt: null },
    },
  ],
};

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe('choices shared by the ask box and the AI chat panel', () => {
  test('the edits switch is one choice wherever it is shown', async () => {
    const { ChatEditsToggle } = await import('./ChatChoices');
    render(
      <>
        <div data-testid="box">
          <ChatEditsToggle />
        </div>
        <div data-testid="panel">
          <ChatEditsToggle compact />
        </div>
      </>,
    );
    const box = within(screen.getByTestId('box'));
    const panel = within(screen.getByTestId('panel'));
    await waitFor(() =>
      expect(panel.getByRole('radio', { name: 'Live wiki' }).getAttribute('aria-checked')).toBe(
        'true',
      ),
    );
    fireEvent.click(box.getByRole('radio', { name: 'Draft' }));
    expect(panel.getByRole('radio', { name: 'Draft' }).getAttribute('aria-checked')).toBe('true');
  });

  test('the model is one choice wherever it is shown, and remembered', async () => {
    const { ChatModelSelect } = await import('./ChatChoices');
    const { chooseChatModel } = await import('@/lib/gitquire/chat-model');
    render(
      <>
        <ChatModelSelect overview={overview} />
        <ChatModelSelect overview={overview} />
      </>,
    );
    const pickers = screen.getAllByRole('combobox', { name: 'Model' });
    expect(pickers.map((picker) => picker.textContent)).toEqual([
      expect.stringContaining('Claude Sonnet 5.5'),
      expect.stringContaining('Claude Sonnet 5.5'),
    ]);
    act(() => chooseChatModel({ provider: 'claude', model: 'claude-haiku-5-5' }));
    for (const picker of pickers) expect(picker.textContent).toContain('Claude Haiku 5.5');
    expect(JSON.parse(window.localStorage.getItem('gitquire.aiChat.model') ?? '')).toEqual({
      provider: 'claude',
      model: 'claude-haiku-5-5',
    });
  });

  test('no model picker without a key', async () => {
    const { ChatModelSelect } = await import('./ChatChoices');
    const [provider] = overview.providers;
    if (provider === undefined) throw new Error('fixture has a provider');
    render(
      <ChatModelSelect
        overview={{
          ...overview,
          providers: [{ ...provider, key: { configured: false, hint: null, savedAt: null } }],
        }}
      />,
    );
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  });
});
