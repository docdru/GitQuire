import { useSyncExternalStore } from 'react';

export interface GitQuireFeatures {
  askAi: boolean;
  agentToken: boolean;
  connector: boolean;
  canUseTokens: boolean;
  canConnect: boolean;
  settingsAdmin: boolean;
  adminLogins: readonly string[];
  adminRepo: string | null;
}

export const STANDALONE_FEATURES: GitQuireFeatures = {
  askAi: true,
  agentToken: false,
  connector: false,
  canUseTokens: false,
  canConnect: false,
  settingsAdmin: true,
  adminLogins: [],
  adminRepo: null,
};

const UNKNOWN_FEATURES: GitQuireFeatures = {
  askAi: false,
  agentToken: false,
  connector: false,
  canUseTokens: false,
  canConnect: false,
  settingsAdmin: true,
  adminLogins: [],
  adminRepo: null,
};
const REFRESH_AFTER_MS = 30_000;

export function parseFeatures(body: unknown): GitQuireFeatures {
  if (typeof body !== 'object' || body === null) return STANDALONE_FEATURES;
  const features = (body as { features?: unknown }).features;
  if (typeof features !== 'object' || features === null) return STANDALONE_FEATURES;
  const f = features as Record<string, unknown>;
  const admins = (body as { admins?: unknown }).admins;
  const adminInfo =
    typeof admins === 'object' && admins !== null ? (admins as Record<string, unknown>) : {};
  return {
    askAi: f.askAi !== false,
    agentToken: f.agentToken === true,
    connector: f.connector === true,
    canUseTokens: f.canUseTokens === true,
    canConnect: f.canConnect === true,
    settingsAdmin: (body as { admin?: unknown }).admin === true,
    adminLogins: Array.isArray(adminInfo.logins)
      ? adminInfo.logins.filter((login): login is string => typeof login === 'string')
      : [],
    adminRepo: typeof adminInfo.repo === 'string' ? adminInfo.repo : null,
  };
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

export function hasClaudeAccess(features: GitQuireFeatures): boolean {
  return features.agentToken || features.connector;
}

let current: GitQuireFeatures | undefined;
let pending: Promise<void> | undefined;
let loadedAt = 0;
let focusHooked = false;
const listeners = new Set<() => void>();

function sameFeatures(a: GitQuireFeatures | undefined, b: GitQuireFeatures): boolean {
  return (
    a !== undefined &&
    a.askAi === b.askAi &&
    a.agentToken === b.agentToken &&
    a.connector === b.connector &&
    a.canUseTokens === b.canUseTokens &&
    a.canConnect === b.canConnect &&
    a.settingsAdmin === b.settingsAdmin &&
    a.adminRepo === b.adminRepo &&
    a.adminLogins.join(',') === b.adminLogins.join(',')
  );
}

function load(): void {
  if (pending !== undefined) return;
  pending = fetchFeatures().then((features) => {
    pending = undefined;
    loadedAt = Date.now();
    if (sameFeatures(current, features)) return;
    current = features;
    for (const listener of listeners) listener();
  });
}

function refreshOnFocus(): void {
  if (Date.now() - loadedAt > REFRESH_AFTER_MS) load();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (current === undefined) load();
  if (!focusHooked && typeof window !== 'undefined') {
    focusHooked = true;
    window.addEventListener('focus', refreshOnFocus);
  }
  return () => listeners.delete(onChange);
}

function snapshot(): GitQuireFeatures {
  return current ?? UNKNOWN_FEATURES;
}

export function useGitQuireFeatures(): GitQuireFeatures {
  return useSyncExternalStore(subscribe, snapshot, () => UNKNOWN_FEATURES);
}

export function useAskAiAvailable(): boolean {
  return useGitQuireFeatures().askAi;
}
