import { useSyncExternalStore } from 'react';

export interface GitQuireRepository {
  owner: string;
  name: string;
  url: string;
  host: string;
}

export function parseRepository(body: unknown): GitQuireRepository | null {
  if (typeof body !== 'object' || body === null) return null;
  const repository = (body as { repository?: unknown }).repository;
  if (typeof repository !== 'object' || repository === null) return null;
  const { owner, name, url, host } = repository as Record<string, unknown>;
  if (typeof owner !== 'string' || typeof name !== 'string' || typeof url !== 'string') {
    return null;
  }
  if (owner === '' || name === '' || !url.startsWith('https://')) return null;
  return { owner, name, url, host: typeof host === 'string' && host !== '' ? host : 'GitHub' };
}

let current: GitQuireRepository | null = null;
let requested = false;
const listeners = new Set<() => void>();

function load(): void {
  if (requested) return;
  requested = true;
  void fetch('/api/gitquire/repository', { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : null))
    .then((body: unknown) => {
      current = parseRepository(body);
      for (const listener of listeners) listener();
    })
    .catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

export function hostLabel(): string {
  load();
  return current?.host ?? 'GitHub';
}

export function useHostLabel(): string {
  return useGitQuireRepository()?.host ?? 'GitHub';
}

export function useGitQuireRepository(): GitQuireRepository | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
