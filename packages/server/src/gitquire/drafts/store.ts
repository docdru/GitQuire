import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DraftRecord } from './model.ts';

export type AgentMode = 'live' | 'draft';

interface StoreFile {
  version: 1;
  drafts: DraftRecord[];
  agentModes: Record<string, AgentMode>;
}

export interface DraftStore {
  all: () => DraftRecord[];
  get: (slug: string) => DraftRecord | undefined;
  put: (draft: DraftRecord) => void;
  agentMode: (userId: number) => AgentMode;
  setAgentMode: (userId: number, mode: AgentMode) => void;
}

export function draftsStatePath(projectDir: string): string {
  return join(projectDir, '.ok', 'local', 'gitquire', 'drafts.json');
}

export function draftsDir(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const override = env.GITQUIRE_DRAFTS_DIR?.trim();
  if (override !== undefined && override !== '') return resolve(override);
  const project = resolve(projectDir);
  return join(dirname(project), '.gitquire-drafts', basename(project));
}

function emptyFile(): StoreFile {
  return { version: 1, drafts: [], agentModes: {} };
}

function load(file: string): StoreFile {
  if (!existsSync(file)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreFile>;
    return {
      version: 1,
      drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
      agentModes:
        typeof parsed.agentModes === 'object' && parsed.agentModes !== null
          ? parsed.agentModes
          : {},
    };
  } catch {
    return emptyFile();
  }
}

export function createDraftStore(file: string): DraftStore {
  const state = load(file);

  function save(): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, file);
  }

  return {
    all: () => state.drafts.map((draft) => ({ ...draft })),
    get: (slug) => {
      const found = state.drafts.find((draft) => draft.slug === slug);
      return found === undefined ? undefined : { ...found };
    },
    put: (draft) => {
      const index = state.drafts.findIndex((existing) => existing.slug === draft.slug);
      if (index === -1) state.drafts.push({ ...draft });
      else state.drafts[index] = { ...draft };
      save();
    },
    agentMode: (userId) => state.agentModes[String(userId)] ?? 'live',
    setAgentMode: (userId, mode) => {
      if (mode === 'live') delete state.agentModes[String(userId)];
      else state.agentModes[String(userId)] = mode;
      save();
    },
  };
}
