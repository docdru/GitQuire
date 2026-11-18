import { useEffect, useSyncExternalStore } from 'react';
import { type AgentMode, fetchAgentMode } from './drafts-api';
import { useDraftState } from './drafts-store';

interface EditTargetState {
  chosen: AgentMode | null;
  setting: AgentMode | null;
}

let state: EditTargetState = { chosen: null, setting: null };
let settingRequest: Promise<void> | undefined;
const listeners = new Set<() => void>();

function emit(next: EditTargetState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): EditTargetState {
  return state;
}

function loadSetting(): void {
  if (settingRequest !== undefined || state.setting !== null) return;
  settingRequest = fetchAgentMode().then(
    (setting) => {
      if (state.setting === null) emit({ ...state, setting });
    },
    () => {
      settingRequest = undefined;
    },
  );
}

export function rememberAgentSetting(setting: AgentMode): void {
  emit({ ...state, setting });
}

export function chooseChatEdits(chosen: AgentMode | null): void {
  emit({ ...state, chosen });
}

export function defaultChatEdits(setting: AgentMode | null, viewingDraft: boolean): AgentMode {
  if (viewingDraft) return 'draft';
  return setting ?? 'live';
}

export interface ChatEdits {
  available: boolean;
  value: AgentMode;
  choose: (value: AgentMode) => void;
}

export function useChatEdits(): ChatEdits {
  const { list, current } = useDraftState();
  const { chosen, setting } = useSyncExternalStore(subscribe, snapshot, snapshot);
  const available = list?.enabled === true;
  useEffect(() => {
    if (available) loadSetting();
  }, [available]);
  return {
    available,
    value: chosen ?? defaultChatEdits(setting, current?.viewing != null),
    choose: (value) => chooseChatEdits(value),
  };
}
