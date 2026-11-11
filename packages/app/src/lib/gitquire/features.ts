import { useSyncExternalStore } from 'react';

export interface GitQuireFeatures {
  askAi: boolean;
}

export const STANDALONE_FEATURES: GitQuireFeatures = { askAi: true };

export function parseFeatures(body: unknown): GitQuireFeatures {
  if (typeof body !== 'object' || body === null) return STANDALONE_FEATURES;
  const features = (body as { features?: unknown }).features;
  if (typeof features !== 'object' || features === null) return STANDALONE_FEATURES;
  const askAi = (features as { askAi?: unknown }).askAi;
  return { askAi: askAi !== false };
}

export async function fetchFeatures(fetchFn: typeof fetch = fetch): Promise<GitQuireFeatures> {
  try {
    const response = await fetchFn('/auth/me', { credentials: 'same-origin' });
    if (!response.ok) return STANDALONE_FEATURES;
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
      return STANDALONE_FEATURES;
    }
    return parseFeatures(await response.json());
  } catch {
    return STANDALONE_FEATURES;
  }
}

let current: GitQuireFeatures | undefined;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();

function load(): void {
  if (current !== undefined || pending !== undefined) return;
  pending = fetchFeatures().then((features) => {
    current = features;
    for (const listener of listeners) listener();
  });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  load();
  return () => listeners.delete(onChange);
}

function askAiSnapshot(): boolean {
  return current?.askAi ?? false;
}

export function useAskAiAvailable(): boolean {
  return useSyncExternalStore(subscribe, askAiSnapshot, () => false);
}
