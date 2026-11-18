import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const drafts = vi.hoisted(() => ({
  enabled: true,
  viewing: null as { slug: string } | null,
  setting: 'live' as 'live' | 'draft',
}));

vi.mock('@/lib/gitquire/features', () => ({ useGitQuireFeatures: () => ({}) }));

vi.mock('@/lib/gitquire/ask-claude', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gitquire/ask-claude')>()),
  askDestinations: () => ['gitquire-chat', 'claude-web'],
  defaultAskDestination: () => 'gitquire-chat',
  loadStoredDestination: () => null,
  storeDestination: () => undefined,
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
