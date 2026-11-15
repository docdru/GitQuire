/**
 * This follows precedent #13b: implicit time-coupling is a test smell, so the primitive accepts
 * `now / setTimeout / clearTimeout` as deps.
 */
import { useEffect, useRef, useState } from 'react';
import { type FetchApiConfigResult, fetchApiConfig } from '@/lib/api-config';
import { defaultCollabWsUrl } from '@/lib/cc1';

const INITIAL_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15_000;
export const TERMINAL_AFTER_MS = 30_000;

type CollabUrlError =
  | { kind: 'error'; code: number | 'network' | 'invalid-body' }
  | { kind: 'null-collab' };

interface UseCollabUrlState {
  collabUrl: string | null;
  attempts: number;
  terminal: boolean;
  lastError: CollabUrlError | null;
  retry: () => void;
}

interface CollabPollState {
  collabUrl: string | null;
  attempts: number;
  terminal: boolean;
  lastError: CollabUrlError | null;
}

const INITIAL_COLLAB_URL_STATE: CollabPollState = {
  collabUrl: null,
  attempts: 0,
  terminal: false,
  lastError: null,
};

interface CollabPollHandle {
  cancel: () => void;
}

interface CollabPollDeps {
  fetchConfig: (signal: AbortSignal) => Promise<FetchApiConfigResult>;
  fallbackUrl: () => string;
  now: () => number;
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  onStateChange: (state: CollabPollState) => void;
  terminalAfterMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

export function runCollabUrlPoll(deps: CollabPollDeps): CollabPollHandle {
  const terminalAfterMs = deps.terminalAfterMs ?? TERMINAL_AFTER_MS;
  const initialDelayMs = deps.initialDelayMs ?? INITIAL_DELAY_MS;
  const maxDelayMs = deps.maxDelayMs ?? MAX_DELAY_MS;
  const log = deps.log ?? { info: console.info, warn: console.warn };

  const ac = new AbortController();
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let delay = initialDelayMs;
  let attempt = 0;
  let cancelled = false;
  let nullCollabLogged = false;
  let lastError: CollabUrlError | null = null;
  const startedAt = deps.now();

  const tick = async (): Promise<void> => {
    attempt += 1;
    let resolved: string | null = null;
    try {
      const result = await deps.fetchConfig(ac.signal);
      if (result.status === 'absent') {
        resolved = deps.fallbackUrl();
        lastError = null;
      } else if (result.status === 'ok' && result.config.collabUrl !== null) {
        resolved = result.config.collabUrl;
        lastError = null;
      } else if (result.status === 'ok') {
        if (!nullCollabLogged) {
          nullCollabLogged = true;
          log.info('[collab-url] server responded but server.lock has no port yet — retrying');
        }
        lastError = { kind: 'null-collab' };
      } else if (result.status === 'error') {
        log.warn(`[collab-url] /api/config error (${result.code}) — retrying in ${delay}ms`);
        lastError = { kind: 'error', code: result.code };
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      lastError = { kind: 'error', code: 'network' };
    }

    if (cancelled) return;

    if (resolved !== null) {
      deps.onStateChange({
        collabUrl: resolved,
        attempts: attempt,
        terminal: false,
        lastError: null,
      });
      return;
    }

    const elapsed = deps.now() - startedAt;
    if (elapsed >= terminalAfterMs) {
      deps.onStateChange({ collabUrl: null, attempts: attempt, terminal: true, lastError });
      return;
    }

    deps.onStateChange({ collabUrl: null, attempts: attempt, terminal: false, lastError });
    timer = deps.setTimeout(() => {
      void tick();
    }, delay);
    delay = Math.min(delay * 2, maxDelayMs);
  };

  void tick();

  return {
    cancel: () => {
      cancelled = true;
      ac.abort();
      if (timer !== null) {
        deps.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

interface LoopState {
  token: number;
}

export function useCollabUrl(): UseCollabUrlState {
  const [state, setState] =
    useState<Pick<UseCollabUrlState, 'collabUrl' | 'attempts' | 'terminal' | 'lastError'>>(
      INITIAL_COLLAB_URL_STATE,
    );
  const retryTokenRef = useRef<LoopState>({ token: 0 });
  const [retrySignal, setRetrySignal] = useState(0);

  useEffect(() => {
    void retrySignal;
    const token = ++retryTokenRef.current.token;

    const handle = runCollabUrlPoll({
      fetchConfig: fetchApiConfig,
      fallbackUrl: defaultCollabWsUrl,
      now: Date.now,
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h),
      onStateChange: (next) => {
        if (token !== retryTokenRef.current.token) return;
        setState(next);
      },
    });

    return () => {
      handle.cancel();
    };
  }, [retrySignal]);

  const retry = () => {
    retryTokenRef.current.token += 1;
    setState((prev) => ({ ...prev, terminal: false, lastError: null }));
    setRetrySignal((v) => v + 1);
  };

  return { ...state, retry };
}
