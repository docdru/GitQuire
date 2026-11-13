import { describe, expect, test } from 'vitest';
import {
  consumePendingDocPanelRequest,
  consumePendingDocPanelTabRequest,
  requestDocPanelTab,
} from '@/components/doc-panel-events';
import { subscribeToActiveTerminalInput } from '@/components/handoff/terminal-input-events';
import { subscribeToTerminalLaunchRequests } from '@/components/handoff/terminal-launch-events';
import { subscribeToAgentThreadLaunchRequests } from '@/components/handoff/thread-launch-events';
import { dispatchNoteWindowMainAction } from './NoteWindowMainActionReceiver';

describe('dispatchNoteWindowMainAction', () => {
  test('re-enters the owning renderer conversation buses', () => {
    const target = new EventTarget();
    const received: unknown[] = [];
    const unsubscribe = [
      subscribeToActiveTerminalInput((detail) => received.push(detail), target),
      subscribeToAgentThreadLaunchRequests((detail) => received.push(detail), target),
      subscribeToTerminalLaunchRequests((request) => {
        if (request.kind === 'cli') {
          received.push({ prompt: request.prompt, cli: request.cli, stage: request.stage });
        }
      }, target),
    ];

    dispatchNoteWindowMainAction(
      { kind: 'active-input', text: 'Explain', newTab: true, submit: true },
      target,
    );
    dispatchNoteWindowMainAction(
      {
        kind: 'agent-thread',
        agentSource: 'custom',
        agentId: 'reviewer',
        prompt: 'Review',
        docName: 'notes/alpha',
        titleHint: 'Review',
      },
      target,
    );
    dispatchNoteWindowMainAction(
      { kind: 'terminal-launch', prompt: 'Review', cli: 'codex', stage: false },
      target,
    );

    expect(received).toEqual([
      { text: 'Explain', newTab: true, submit: true },
      {
        agentSource: 'custom',
        agentId: 'reviewer',
        prompt: 'Review',
        docName: 'notes/alpha',
        titleHint: 'Review',
        attachments: null,
      },
      { prompt: 'Review', cli: 'codex', stage: false },
    ]);
    for (const stop of unsubscribe) stop();
  });

  test('does not latch detailed requests addressed to a foreign renderer target', () => {
    requestDocPanelTab('problems', { scope: 'doc', focus: 'panel' }, new EventTarget());

    expect(consumePendingDocPanelRequest('problems')).toBeNull();
    expect(consumePendingDocPanelTabRequest()).toBeNull();
  });
});
