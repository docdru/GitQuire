const EVENT = 'gitquire:chat-keys-changed';

export function notifyChatKeysChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onChatKeysChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
