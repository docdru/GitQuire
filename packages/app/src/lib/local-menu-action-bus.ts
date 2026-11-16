import type { GqMenuAction, GqMenuActionOrigin } from './desktop-bridge-types';

type Listener = (action: GqMenuAction, origin: GqMenuActionOrigin) => void;

const LAUNCHER_FREE_ORIGIN: GqMenuActionOrigin = Object.freeze({ launcherBorne: false });

const listeners = new Set<Listener>();

export function subscribeLocalMenuAction(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function emitLocalMenuAction(
  action: GqMenuAction,
  origin: GqMenuActionOrigin = LAUNCHER_FREE_ORIGIN,
): void {
  for (const cb of listeners) {
    try {
      cb(action, origin);
    } catch (err) {
      console.error('[local-menu-action-bus] subscriber threw during dispatch:', err);
    }
  }
}

export function __resetLocalMenuActionBusForTests(): void {
  listeners.clear();
}
