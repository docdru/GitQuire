import { checkPersonalSettings, type PersonalSettingsProblem } from '../personal-settings.ts';
import { type PeopleStore, SETTINGS_FILE } from './store.ts';

export type AgentMode = 'live' | 'draft';

interface Prefs {
  agentMode?: AgentMode;
}

function parsePrefs(raw: unknown): Prefs {
  if (typeof raw !== 'object' || raw === null) return {};
  const mode = (raw as { agentMode?: unknown }).agentMode;
  return mode === 'draft' || mode === 'live' ? { agentMode: mode } : {};
}

export function isAgentMode(value: unknown): value is AgentMode {
  return value === 'live' || value === 'draft';
}

export interface PersonSettings {
  read: (person: string) => string;
  write: (person: string, yaml: string) => PersonalSettingsProblem | undefined;
  agentMode: (person: string) => AgentMode;
  setAgentMode: (person: string, mode: AgentMode) => AgentMode;
}

export function personSettings(store: PeopleStore): PersonSettings {
  return {
    read: (person) => store.readText(person, SETTINGS_FILE),
    write: (person, yaml) => {
      const problem = checkPersonalSettings(yaml);
      if (problem !== undefined) return problem;
      store.writeText(person, SETTINGS_FILE, yaml);
      return undefined;
    },
    agentMode: (person) => store.readJson(person, 'prefs.json', parsePrefs).agentMode ?? 'live',
    setAgentMode: (person, mode) =>
      store.updateJson(person, 'prefs.json', parsePrefs, (prefs) => ({ ...prefs, agentMode: mode }))
        .agentMode ?? 'live',
  };
}
