import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatPanel } from './ChatPanel';

export function ChatPaneHost({
  container,
  isShowing,
}: {
  container: HTMLElement | null;
  isShowing: boolean;
}) {
  const [host] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const element = document.createElement('div');
    element.className = 'flex min-h-0 flex-1 flex-col overflow-hidden';
    element.dataset.testid = 'ai-chat-pane';
    return element;
  });
  const [attached, setAttached] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (host === null) return;
    return () => host.remove();
  }, [host]);

  useLayoutEffect(() => {
    if (host === null || container === null) return;
    if (host.parentElement !== container) container.appendChild(host);
    setAttached(host);
  }, [host, container]);

  if (attached === null) return null;
  return createPortal(isShowing ? <ChatPanel /> : null, attached);
}
