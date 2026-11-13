import { afterEach, describe, expect, test, vi } from 'vitest';
import { requestActiveTerminalInput } from '@/components/handoff/terminal-input-events';
import { requestTerminalLaunch } from '@/components/handoff/terminal-launch-events';
import { requestAgentThreadLaunch } from '@/components/handoff/thread-launch-events';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

function installNoteBridge() {
  const dispatchToMain = vi.fn(async () => ({ ok: true as const }));
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: {
      config: { mode: 'note' },
      noteWindow: { dispatchToMain },
    } as unknown as OkDesktopBridge,
  });
  return dispatchToMain;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'okDesktop');
});

describe('note-window main action routing', () => {
  test('Ask AI input is handed to the owning project window', () => {
    const dispatch = installNoteBridge();

    requestActiveTerminalInput('Review this passage', { newTab: true, submit: true });

    expect(dispatch).toHaveBeenCalledWith({
      kind: 'active-input',
      text: 'Review this passage',
      newTab: true,
      submit: true,
    });
  });

  test('agent and terminal launches are handed to the owning project window', () => {
    const dispatch = installNoteBridge();

    requestAgentThreadLaunch({
      agentSource: 'registry',
      agentId: 'claude',
      prompt: 'Review this note',
      docName: 'notes/alpha',
      titleHint: 'Review',
      attachments: null,
    });
    requestTerminalLaunch('Review this note', 'codex', { stage: false });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      {
        kind: 'agent-thread',
        agentSource: 'registry',
        agentId: 'claude',
        prompt: 'Review this note',
        docName: 'notes/alpha',
        titleHint: 'Review',
      },
      {
        kind: 'terminal-launch',
        prompt: 'Review this note',
        cli: 'codex',
        stage: false,
      },
    ]);
  });

  test('a main-side refusal that RESOLVES { ok: false } is logged, not silently dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dispatchToMain = vi.fn(async () => ({
      ok: false as const,
      reason: 'project-not-open' as const,
    }));
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: {
        config: { mode: 'note' },
        noteWindow: { dispatchToMain },
      } as unknown as OkDesktopBridge,
    });

    requestActiveTerminalInput('Review this passage', { newTab: true, submit: true });

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[note-window] main-window action dispatch declined',
        expect.objectContaining({ reason: 'project-not-open', kind: 'active-input' }),
      ),
    );
    warn.mockRestore();
  });
});
