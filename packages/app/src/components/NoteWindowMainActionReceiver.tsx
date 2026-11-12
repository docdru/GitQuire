import type { OkNoteWindowMainAction } from '@inkeep/open-knowledge-core/desktop-bridge';
import { useEffect } from 'react';
import { requestActiveTerminalInput } from '@/components/handoff/terminal-input-events';
import { requestTerminalLaunch } from '@/components/handoff/terminal-launch-events';
import { requestAgentThreadLaunch } from '@/components/handoff/thread-launch-events';
import { isNoteWindow } from '@/lib/note-window-mode';

export function dispatchNoteWindowMainAction(
  action: OkNoteWindowMainAction,
  target: Window | EventTarget,
): void {
  switch (action.kind) {
    case 'active-input':
      requestActiveTerminalInput(
        action.text,
        {
          newTab: action.newTab,
          submit: action.submit,
          target: action.target,
        },
        target,
      );
      return;
    case 'agent-thread':
      requestAgentThreadLaunch(
        {
          agentSource: action.agentSource,
          agentId: action.agentId,
          prompt: action.prompt,
          docName: action.docName,
          titleHint: action.titleHint,
          attachments: null,
        },
        target,
      );
      return;
    case 'terminal-launch':
      requestTerminalLaunch(action.prompt, action.cli, { stage: action.stage }, target);
      return;
  }
}

export function NoteWindowMainActionReceiver() {
  useEffect(() => {
    if (isNoteWindow()) return;
    const subscribe = window.okDesktop?.noteWindow?.onMainAction;
    if (typeof subscribe !== 'function') return;
    return subscribe((action) => dispatchNoteWindowMainAction(action, window));
  }, []);

  return null;
}
