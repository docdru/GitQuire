import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommentAuthor } from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import type { Mention, MentionIndex } from './mentions.ts';
import type { PageFacts } from './page-objects.ts';

export const BASELINE_AT = '1970-01-01T00:00:00.000Z';
export const WRITER_WINDOW_MS = 10 * 60 * 1000;
const MAX_BODY_CHARS = 280;
const MAX_TRACKED = 20_000;
const UNKNOWN_AUTHOR: CommentAuthor = { id: '' };

interface SeenEntry {
  at: string;
  author?: CommentAuthor;
}

interface SeenState {
  version: 1;
  seen: Record<string, SeenEntry>;
}

export interface ActionItemPage {
  path: string;
  facts: PageFacts;
}

export interface ActionItemMentionDeps {
  stateFile: string;
  pages: () => ActionItemPage[];
  writerOf?: (docName: string) => CommentAuthor | undefined;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export function actionItemStatePath(projectDir: string): string {
  return join(projectDir, '.ok', 'local', 'gitquire', 'action-item-mentions.json');
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_BODY_CHARS ? flat : `${flat.slice(0, MAX_BODY_CHARS - 1)}…`;
}

function readState(file: string): SeenState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SeenState>;
    if (parsed?.version !== 1 || typeof parsed.seen !== 'object' || parsed.seen === null) {
      return undefined;
    }
    return { version: 1, seen: parsed.seen };
  } catch {
    return undefined;
  }
}

function writeState(file: string, state: SeenState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`);
  renameSync(temporary, file);
}

interface OpenTask {
  id: string;
  path: string;
  docName: string;
  title: string;
  text: string;
  logins: string[];
}

function openTasks(pages: readonly ActionItemPage[]): OpenTask[] {
  const found: OpenTask[] = [];
  for (const { path, facts } of pages) {
    for (const task of facts.tasks) {
      if (task.done || task.mentions.length === 0) continue;
      found.push({
        id: `task:${facts.docName}:${task.id}`,
        path,
        docName: facts.docName,
        title: facts.title === '' ? facts.docName : facts.title,
        text: task.text,
        logins: task.mentions,
      });
    }
  }
  return found;
}

export function createActionItemMentions(deps: ActionItemMentionDeps): MentionIndex {
  const now = deps.now ?? Date.now;
  let state = readState(deps.stateFile);

  return {
    all() {
      const tasks = openTasks(deps.pages());
      const firstRun = state === undefined;
      const previous = state?.seen ?? {};
      const seen: Record<string, SeenEntry> = {};
      let changed = firstRun;
      for (const task of tasks.slice(0, MAX_TRACKED)) {
        if (Object.hasOwn(seen, task.id)) continue;
        const known = Object.hasOwn(previous, task.id) ? previous[task.id] : undefined;
        if (known !== undefined) {
          seen[task.id] = known;
          continue;
        }
        changed = true;
        if (firstRun) {
          seen[task.id] = { at: BASELINE_AT };
          continue;
        }
        const author = deps.writerOf?.(task.docName);
        seen[task.id] = {
          at: new Date(now()).toISOString(),
          ...(author === undefined ? {} : { author }),
        };
      }
      if (!changed && Object.keys(previous).length !== Object.keys(seen).length) changed = true;
      state = { version: 1, seen };
      if (changed) {
        try {
          writeState(deps.stateFile, state);
        } catch (err) {
          deps.onError?.(err);
        }
      }
      return tasks.flatMap((task): Mention[] => {
        const entry = seen[task.id];
        if (entry === undefined) return [];
        return [
          {
            id: task.id,
            kind: 'task',
            path: task.path,
            docName: task.docName,
            threadId: '',
            commentId: '',
            author: entry.author ?? UNKNOWN_AUTHOR,
            at: entry.at,
            body: clip(task.text),
            quote: task.title,
            resolved: false,
            logins: task.logins,
            ...(entry.at === BASELINE_AT ? { quiet: true } : {}),
          },
        ];
      });
    },
  };
}

export function combinedMentionIndex(...indexes: readonly MentionIndex[]): MentionIndex {
  return { all: () => indexes.flatMap((index) => index.all()) };
}
