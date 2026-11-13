import type { ConfigDocProvider } from '@inkeep/open-knowledge-core/config/bind-config-doc';
import * as Y from 'yjs';

const SETTINGS_URL = '/api/gitquire/me/settings';
const SAVE_DELAY_MS = 400;
const LOAD_ORIGIN = Symbol('gitquire-personal-settings-load');

export type PersonalSettingsProbe =
  | { personal: false }
  | { personal: true; login: string; yaml: string };

export async function probePersonalSettings(
  fetchFn: typeof fetch = fetch,
): Promise<PersonalSettingsProbe> {
  try {
    const response = await fetchFn(SETTINGS_URL, { credentials: 'same-origin' });
    if (!response.ok) return { personal: false };
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
      return { personal: false };
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (body.personal !== true || typeof body.yaml !== 'string') return { personal: false };
    return {
      personal: true,
      login: typeof body.login === 'string' ? body.login : '',
      yaml: body.yaml,
    };
  } catch {
    return { personal: false };
  }
}

export interface PersonalSettingsProvider extends ConfigDocProvider {
  load(yaml: string): void;
  flush(): Promise<void>;
  destroy(): void;
}

export interface PersonalSettingsOptions {
  save?: (yaml: string) => Promise<void>;
  onSaveFailed?: (error: unknown) => void;
  saveDelayMs?: number;
}

async function saveToServer(yaml: string): Promise<void> {
  const response = await fetch(SETTINGS_URL, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ yaml }),
  });
  if (!response.ok) throw new Error(`Saving settings failed with HTTP ${response.status}.`);
}

export function createPersonalSettingsProvider(
  options: PersonalSettingsOptions = {},
): PersonalSettingsProvider {
  const save = options.save ?? saveToServer;
  const saveDelayMs = options.saveDelayMs ?? SAVE_DELAY_MS;
  const document = new Y.Doc();
  const text = document.getText('source');
  const syncedListeners = new Set<() => void>();
  let loaded = false;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    timer = undefined;
    const yaml = text.toString();
    saving = saving
      .then(() => save(yaml))
      .catch((error: unknown) => {
        options.onSaveFailed?.(error);
      });
    return saving;
  }

  document.on('update', (_update: Uint8Array, origin: unknown) => {
    if (!loaded || destroyed || origin === LOAD_ORIGIN) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void persist(), saveDelayMs);
  });

  return {
    document,
    on(_event, listener) {
      syncedListeners.add(listener);
    },
    off(_event, listener) {
      syncedListeners.delete(listener);
    },
    load(yaml) {
      if (destroyed || loaded) return;
      document.transact(() => {
        text.insert(0, yaml);
      }, LOAD_ORIGIN);
      loaded = true;
      for (const listener of syncedListeners) listener();
    },
    flush() {
      if (timer === undefined) return saving;
      clearTimeout(timer);
      return persist();
    },
    destroy() {
      if (destroyed) return;
      if (timer !== undefined) {
        clearTimeout(timer);
        void persist();
      }
      destroyed = true;
      syncedListeners.clear();
      document.destroy();
    },
  };
}
