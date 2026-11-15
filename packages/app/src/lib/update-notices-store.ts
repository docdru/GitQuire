import type { UpdateNotice } from '@/components/UpdateNotices.shared';

let notices: UpdateNotice[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function dismissNotice(id: string): void {
  const next = notices.filter((n) => n.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  notify();
}

export function getNoticesSnapshot(): UpdateNotice[] {
  return notices;
}

export function subscribeToNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
