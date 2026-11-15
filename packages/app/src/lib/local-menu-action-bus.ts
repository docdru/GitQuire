import type { OkMenuAction, OkMenuActionOrigin } from './desktop-bridge-types';

type Listener = (action: OkMenuAction, origin: OkMenuActionOrigin) => void;

const LAUNCHER_FREE_ORIGIN: OkMenuActionOrigin = Object.freeze({ launcherBorne: false });

const listeners = new Set<Listener>();

export function subscribeLocalMenuAction(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function emitLocalMenuAction(
  action: OkMenuAction,
  origin: OkMenuActionOrigin = LAUNCHER_FREE_ORIGIN,
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
