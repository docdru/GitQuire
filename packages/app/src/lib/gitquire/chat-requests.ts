const EVENT = 'gitquire:chat-request';
let pending: string | null = null;

export function queueChatRequest(text: string): void {
  pending = text;
  window.dispatchEvent(new Event(EVENT));
}

export function takeChatRequest(): string | null {
  const text = pending;
  pending = null;
  return text;
}

export function onChatRequest(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
