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

export type ColumnValue = string | number | boolean;

function isSimple(value: FieldValue | undefined): value is ColumnValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function columnName(value: FieldValue | undefined): string | undefined {
  if (!isSimple(value)) return undefined;
  const name = fieldText(value).trim();
  return name === '' ? undefined : name;
}

interface KeyValues {
  values: Set<string>;
  unusable: boolean;
}

function keyValues(pages: readonly PageObject[]): Map<string, KeyValues> {
  const found = new Map<string, KeyValues>();
  for (const page of pages) {
    for (const key of Object.keys(page.fields)) {
      if (key === 'title') continue;
      const value = fieldOf(page, key);
      if (value === null || value === undefined) continue;
      const entry = found.get(key) ?? { values: new Set<string>(), unusable: false };
      const name = columnName(value);
      if (!isSimple(value)) entry.unusable = true;
      if (name !== undefined) entry.values.add(name);
      found.set(key, entry);
    }
  }
  return found;
}

export function boardGroupKeys(pages: readonly PageObject[]): string[] {
  const usable = [...keyValues(pages)]
    .filter(
      ([, entry]) =>
        !entry.unusable && entry.values.size >= 2 && entry.values.size <= MAX_BOARD_COLUMNS,
    )
    .map(([key]) => key);
  const rank = (key: string): number => {
    const preferred = PREFERRED_GROUP_KEYS.indexOf(key.toLowerCase());
    return preferred === -1 ? PREFERRED_GROUP_KEYS.length : preferred;
  };
  return usable.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function canKeepGrouping(pages: readonly PageObject[], key: string): boolean {
  const entry = keyValues(pages).get(key);
  return (
    entry !== undefined &&
    !entry.unusable &&
    entry.values.size >= 1 &&
    entry.values.size <= MAX_BOARD_COLUMNS
  );
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
  raw: ColumnValue | null;
  pages: PageObject[];
}

export interface Board {
  groupKey: string;
  columns: BoardColumn[];
}

function onBoard(page: PageObject, view: BoardView): boolean {
  return hasFields(page) && matchesFilter(page, view.filterKey, view.filterValue);
}

export function chooseGroupKey(pages: readonly PageObject[], wanted: string): string | undefined {
  if (wanted !== '' && canKeepGrouping(pages, wanted)) return wanted;
  return boardGroupKeys(pages)[0];
}

export function buildBoard(
  basis: readonly PageObject[],
  view: BoardView,
  shown: readonly PageObject[] = basis,
): Board | null {
  const groupKey = chooseGroupKey(basis, view.groupKey);
  if (groupKey === undefined) return null;
  const lists = new Map<string, BoardColumn>();
  for (const page of [...basis, ...shown]) {
    const value = fieldOf(page, groupKey);
    const name = columnName(value);
    if (name !== undefined && isSimple(value) && !lists.has(name)) {
      lists.set(name, { value: name, raw: value, pages: [] });
    }
  }
  const unplaced: PageObject[] = [];
  for (const page of shown) {
    if (!onBoard(page, view)) continue;
    const name = columnName(fieldOf(page, groupKey));
    const column = name === undefined ? undefined : lists.get(name);
    if (column === undefined) {
      unplaced.push(page);
    } else {
      column.pages.push(page);
    }
  }
  const ordered = [...lists.values()].sort(
    (a, b) =>
      stageRank(a.value) - stageRank(b.value) ||
      a.value.localeCompare(b.value, undefined, { numeric: true }),
  );
  for (const column of ordered) {
    column.pages.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }
  if (view.filterKey !== '') ordered.unshift({ value: '', raw: null, pages: unplaced });
  return { groupKey, columns: ordered };
}

export interface PendingMove {
  key: string;
  value: ColumnValue | null;
}

export function withFieldValue(
  page: PageObject,
  key: string,
  value: ColumnValue | null,
): PageObject {
  const fields = { ...page.fields };
  if (value === null) {
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
  value: ColumnValue | null,
): PageObject[] {
  return pages.map((page) => (page.docName === docName ? withFieldValue(page, key, value) : page));
}

export function applyPendingMoves(
  pages: readonly PageObject[],
  pending: ReadonlyMap<string, PendingMove>,
): PageObject[] {
  if (pending.size === 0) return [...pages];
  return pages.map((page) => {
    const move = pending.get(page.docName);
    return move === undefined ? page : withFieldValue(page, move.key, move.value);
  });
}

export const BOARD_CLIENT_NAME = 'gitquire-board';

export function setPageField(
  docName: string,
  key: string,
  value: ColumnValue | null,
  deps: ApiDeps = {},
): Promise<unknown> {
  const body = {
    docName,
    patch: { [key]: value },
    summary: value === null ? `Clear ${key}` : `Set ${key} to ${String(value)}`,
    clientName: BOARD_CLIENT_NAME,
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
