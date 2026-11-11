import { type ApiDeps, gitquireRequest } from './branch-api';
import {
  type FieldValue,
  fieldOf,
  fieldText,
  hasFields,
  matchesFilter,
  type PageObject,
  type PageTask,
} from './objects';

const MAX_BOARD_COLUMNS = 12;
const PREFERRED_GROUP_KEYS = ['status', 'state', 'stage', 'phase'];

const STAGE_WORDS: readonly (readonly string[])[] = [
  ['backlog', 'idea', 'ideas', 'someday', 'proposed', 'draft'],
  ['to do', 'todo', 'open', 'planned', 'next', 'ready', 'new'],
  ['doing', 'in progress', 'wip', 'started', 'active', 'ongoing'],
  ['review', 'in review', 'blocked', 'waiting', 'on hold', 'testing'],
  ['done', 'closed', 'complete', 'completed', 'accepted', 'rejected', 'shipped', 'cancelled'],
];
const UNKNOWN_STAGE = 2.5;

export function stageRank(value: string): number {
  const lower = value.trim().toLowerCase();
  const index = STAGE_WORDS.findIndex((words) => words.includes(lower));
  return index === -1 ? UNKNOWN_STAGE : index;
}

function isSimple(value: FieldValue | undefined): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export function boardGroupKeys(pages: readonly PageObject[]): string[] {
  const values = new Map<string, Set<string>>();
  const unusable = new Set<string>();
  for (const page of pages) {
    for (const [key, value] of Object.entries(page.fields)) {
      if (value === null) continue;
      if (!isSimple(value)) {
        unusable.add(key);
        continue;
      }
      const seen = values.get(key) ?? new Set<string>();
      seen.add(fieldText(value));
      values.set(key, seen);
    }
  }
  const usable = [...values]
    .filter(([key, seen]) => !unusable.has(key) && seen.size >= 2 && seen.size <= MAX_BOARD_COLUMNS)
    .map(([key]) => key);
  const rank = (key: string): number => {
    const preferred = PREFERRED_GROUP_KEYS.indexOf(key.toLowerCase());
    return preferred === -1 ? PREFERRED_GROUP_KEYS.length : preferred;
  };
  return usable.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface BoardView {
  groupKey: string;
  filterKey: string;
  filterValue: string;
}

export const EMPTY_BOARD_VIEW: BoardView = { groupKey: '', filterKey: '', filterValue: '' };

export function readBoardView(raw: string | null): BoardView {
  if (raw === null) return EMPTY_BOARD_VIEW;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_BOARD_VIEW;
    const saved = parsed as Record<string, unknown>;
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    return {
      groupKey: text(saved.groupKey),
      filterKey: text(saved.filterKey),
      filterValue: text(saved.filterValue),
    };
  } catch {
    return EMPTY_BOARD_VIEW;
  }
}

export interface BoardColumn {
  value: string;
  pages: PageObject[];
}

export interface Board {
  groupKey: string;
  columns: BoardColumn[];
}

function onBoard(page: PageObject, view: BoardView): boolean {
  return hasFields(page) && matchesFilter(page, view.filterKey, view.filterValue);
}

export function buildBoard(pages: readonly PageObject[], view: BoardView): Board | null {
  const keys = boardGroupKeys(pages);
  const groupKey = keys.includes(view.groupKey) ? view.groupKey : keys[0];
  if (groupKey === undefined) return null;
  const lists = new Map<string, PageObject[]>();
  const unplaced: PageObject[] = [];
  for (const page of pages) {
    const value = fieldOf(page, groupKey);
    const name = isSimple(value) ? fieldText(value) : undefined;
    const list = name === undefined ? unplaced : (lists.get(name) ?? []);
    if (name !== undefined) lists.set(name, list);
    if (onBoard(page, view)) list.push(page);
  }
  const ordered = [...lists]
    .map(([value, list]) => ({ value, pages: list }))
    .sort(
      (a, b) =>
        stageRank(a.value) - stageRank(b.value) ||
        a.value.localeCompare(b.value, undefined, { numeric: true }),
    );
  for (const column of ordered) {
    column.pages.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }
  const withoutValue = view.filterKey === '' ? [] : unplaced;
  if (withoutValue.length > 0) ordered.unshift({ value: '', pages: withoutValue });
  return { groupKey, columns: ordered };
}

export function withFieldValue(page: PageObject, key: string, value: string): PageObject {
  const fields = { ...page.fields };
  if (value === '') {
    delete fields[key];
  } else {
    fields[key] = value;
  }
  return { ...page, fields };
}

export function movePage(
  pages: readonly PageObject[],
  docName: string,
  key: string,
  value: string,
): PageObject[] {
  return pages.map((page) => (page.docName === docName ? withFieldValue(page, key, value) : page));
}

export function setPageField(
  docName: string,
  key: string,
  value: string,
  deps: ApiDeps = {},
): Promise<unknown> {
  const body = {
    docName,
    patch: { [key]: value === '' ? null : value },
    summary: value === '' ? `Clear ${key}` : `Set ${key} to ${value}`,
  };
  return gitquireRequest('/api/frontmatter-patch', { method: 'POST', body }, deps);
}

export interface ActionItem {
  id: string;
  docName: string;
  pageTitle: string;
  text: string;
  done: boolean;
  line: number;
  mentions: string[];
}

function actionItem(page: PageObject, task: PageTask): ActionItem {
  return {
    id: `${page.docName}#${task.id}`,
    docName: page.docName,
    pageTitle: page.title,
    text: task.text,
    done: task.done,
    line: task.line,
    mentions: task.mentions,
  };
}

export function actionItems(pages: readonly PageObject[]): ActionItem[] {
  return pages.flatMap((page) => page.tasks.map((task) => actionItem(page, task)));
}

export interface ActionFilter {
  person: string;
  showDone: boolean;
  search: string;
}

export const UNASSIGNED = '@none';

export function filterActionItems(
  items: readonly ActionItem[],
  filter: ActionFilter,
): ActionItem[] {
  const wanted = filter.search.trim().toLowerCase();
  const person = filter.person.toLowerCase();
  return items.filter((item) => {
    if (item.done && !filter.showDone) return false;
    if (person === UNASSIGNED && item.mentions.length > 0) return false;
    if (person !== '' && person !== UNASSIGNED && !item.mentions.includes(person)) return false;
    if (wanted === '') return true;
    const haystack = `${item.text}\n${item.pageTitle}`.toLowerCase();
    return haystack.includes(wanted);
  });
}

export interface PersonSummary {
  login: string;
  open: number;
}

export function actionPeople(items: readonly ActionItem[]): PersonSummary[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.done) continue;
    for (const login of item.mentions) counts.set(login, (counts.get(login) ?? 0) + 1);
  }
  return [...counts]
    .map(([login, open]) => ({ login, open }))
    .sort((a, b) => b.open - a.open || a.login.localeCompare(b.login));
}

export interface ActionGroup {
  docName: string;
  pageTitle: string;
  items: ActionItem[];
}

export function groupActionItems(items: readonly ActionItem[]): ActionGroup[] {
  const groups = new Map<string, ActionGroup>();
  for (const item of items) {
    const group = groups.get(item.docName) ?? {
      docName: item.docName,
      pageTitle: item.pageTitle,
      items: [],
    };
    group.items.push(item);
    groups.set(item.docName, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.pageTitle.localeCompare(b.pageTitle, undefined, { numeric: true }),
  );
}
