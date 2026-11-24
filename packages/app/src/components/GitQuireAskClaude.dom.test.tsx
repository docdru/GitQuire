import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const drafts = vi.hoisted(() => ({
  enabled: true,
  viewing: null as { slug: string } | null,
  setting: 'live' as 'live' | 'draft',
}));

const ask = vi.hoisted(() => ({
  destination: 'gitquire-chat' as 'gitquire-chat' | 'claude-web',
  prefix: '',
  opened: [] as string[],
}));

vi.mock('@/lib/gitquire/features', () => ({ useGitQuireFeatures: () => ({}) }));

vi.mock('@/lib/gitquire/wiki-prefix', () => ({ wikiPrefix: () => ask.prefix }));

vi.mock('@/lib/gitquire/ask-claude', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gitquire/ask-claude')>()),
  askDestinations: () => ['gitquire-chat', 'claude-web'],
  defaultAskDestination: () => ask.destination,
  loadStoredDestination: () => null,
  storeDestination: () => undefined,
  openClaudeLink: (url: string) => {
    ask.opened.push(url);
  },
}));

vi.mock('@/lib/gitquire/drafts-store', () => ({
  useDraftState: () => ({
    loaded: true,
    list: { enabled: drafts.enabled, me: 'alice', viewing: null, drafts: [] },
    current: { viewing: drafts.viewing, drift: null, closed: null },
  }),
}));

vi.mock('@/lib/gitquire/drafts-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gitquire/drafts-api')>()),
  fetchAgentMode: async () => drafts.setting,
}));

async function load() {
  const { GitQuireAskClaude } = await import('./GitQuireAskClaude');
  const target = await import('@/lib/gitquire/chat-edit-target');
  render(<GitQuireAskClaude docName="notes/plan" />);
  return target;
}

const option = (name: string) => screen.getByRole('radio', { name });

beforeEach(() => {
  vi.resetModules();
  ask.destination = 'gitquire-chat';
  ask.prefix = '';
  ask.opened = [];
  drafts.enabled = true;
  drafts.viewing = null;
  drafts.setting = 'live';
});

afterEach(() => {
  cleanup();
});

describe('where the AI chat puts its edits', () => {
  test('shows the switch next to the chat choice, starting from the setting', async () => {
    drafts.setting = 'draft';
    await load();
    expect(screen.getByTestId('gitquire-chat-edits').textContent).toContain('Edits go to:');
    await waitFor(() => expect(option('Draft').getAttribute('aria-checked')).toBe('true'));
    expect(option('Live wiki').getAttribute('aria-checked')).toBe('false');
  });

  test('starts on the draft when one is open', async () => {
    drafts.viewing = { slug: 'plan' };
    await load();
    expect(option('Draft').getAttribute('aria-checked')).toBe('true');
  });

  test('a change applies to this chat and leaves the setting alone', async () => {
    const target = await load();
    await waitFor(() => expect(option('Live wiki').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(option('Draft'));
    expect(option('Draft').getAttribute('aria-checked')).toBe('true');
    expect(target.defaultChatEdits('live', false)).toBe('live');

    target.chooseChatEdits(null);
    await waitFor(() => expect(option('Live wiki').getAttribute('aria-checked')).toBe('true'));
  });

  test('is hidden when drafts are off', async () => {
    drafts.enabled = false;
    await load();
    expect(screen.queryByTestId('gitquire-chat-edits')).toBeNull();
  });
});

describe('the model for the AI chat', () => {
  test('can be chosen in the ask box when a key is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/gitquire/chat'
          ? new Response(
              JSON.stringify({
                available: true,
                retentionDays: 90,
                providers: [
                  {
                    id: 'claude',
                    label: 'Claude (Anthropic)',
                    models: [
                      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'balanced' },
                    ],
                    defaultModel: 'claude-sonnet-5-5',
                    keyUrl: '',
                    limitsUrl: '',
                    key: { configured: true, hint: '…1234', savedAt: null },
                  },
                ],
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          : new Response('{}', { status: 404 }),
      ),
    );
    try {
      await load();
      const picker = await screen.findByRole('combobox', { name: 'Model' });
      expect(picker.textContent).toContain('Claude Sonnet 5.5');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('where Claude outside GitQuire puts its edits', () => {
  test('behind the front door, the choice goes into the request as the workspace argument', async () => {
    ask.destination = 'claude-web';
    ask.prefix = '/w/github/team/a';
    await load();
    await waitFor(() => expect(option('Live wiki').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(option('Draft'));
    const input = screen.getByRole('textbox', { name: 'Ask Claude' });
    fireEvent.change(input, { target: { value: 'Shorten the intro' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ask.opened).toHaveLength(1);
    const prompt = decodeURIComponent(ask.opened[0]?.split('?q=')[1] ?? '');
    expect(prompt).toContain('Give "draft" as the workspace argument of every call.');
  });

  test('a single wiki has no such argument, so no switch', async () => {
    ask.destination = 'claude-web';
    await load();
    expect(screen.queryByTestId('gitquire-chat-edits')).toBeNull();
  });
});
