import { useSyncExternalStore } from 'react';
import type { ChatOverview, ChatProvider } from './chat-api';

const MODEL_STORAGE_KEY = 'gitquire.aiChat.model';

export interface ChatModelChoice {
  provider: ChatProvider;
  model: string;
}

function parse(raw: string | null): ChatModelChoice | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as ChatModelChoice;
    return parsed.provider === 'claude' || parsed.provider === 'mistral' ? parsed : null;
  } catch {
    return null;
  }
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

let cached: { raw: string | null; choice: ChatModelChoice | null } | undefined;
const listeners = new Set<() => void>();

function snapshot(): ChatModelChoice | null {
  const raw = readRaw();
  if (cached === undefined || cached.raw !== raw) cached = { raw, choice: parse(raw) };
  return cached.choice;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function chooseChatModel(choice: ChatModelChoice): void {
  const raw = JSON.stringify(choice);
  cached = { raw, choice };
  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, raw);
  } catch {}
  for (const listener of listeners) listener();
}

export function useChosenChatModel(): ChatModelChoice | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function pickSelection(
  overview: ChatOverview,
  stored: ChatModelChoice | null,
): ChatModelChoice | null {
  const usable = overview.providers.filter((provider) => provider.key.configured);
  const storedProvider = usable.find((provider) => provider.id === stored?.provider);
  if (storedProvider !== undefined && stored !== null) {
    const model = storedProvider.models.some((entry) => entry.id === stored.model)
      ? stored.model
      : storedProvider.defaultModel;
    return { provider: storedProvider.id, model };
  }
  const first = usable[0];
  return first === undefined ? null : { provider: first.id, model: first.defaultModel };
}
