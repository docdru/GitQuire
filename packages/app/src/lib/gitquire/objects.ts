import { type ApiDeps, gitquireRequest } from './branch-api';

export type FieldValue =
  | string
  | number
  | boolean
  | null
  | FieldValue[]
  | { [key: string]: FieldValue };

export interface PageTask {
  id: string;
  text: string;
  done: boolean;
  line: number;
  mentions: string[];
  source?: string;
  offset?: number;
  due?: string;
}

export interface PageObject {
  docName: string;
  path: string;
  title: string;
  modified: string;
  fields: Record<string, FieldValue>;
  tasks: PageTask[];
  decisions?: string[];
  clipped?: boolean;
}

export interface ObjectList {
  pages: PageObject[];
  truncated: boolean;
}

export function fetchObjects(deps: ApiDeps = {}): Promise<ObjectList> {
  return gitquireRequest('/api/gitquire/objects', {}, deps);
}

export function fieldText(value: FieldValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map((item) => fieldText(item)).join(', ');
  return JSON.stringify(value) ?? '';
}

export function fieldOf(page: PageObject, key: string): FieldValue | undefined {
  return Object.hasOwn(page.fields, key) ? page.fields[key] : undefined;
}

export function fieldChoices(value: FieldValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => fieldText(item)).filter((text) => text !== '');
  }
  const text = fieldText(value);
  return text === '' ? [] : [text];
}

export interface FieldSummary {
  key: string;
  pages: number;
}

export function summarizeFields(pages: readonly PageObject[]): FieldSummary[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const key of Object.keys(page.fields)) {
      if (fieldChoices(fieldOf(page, key)).length === 0) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([key, count]) => ({ key, pages: count }))
    .sort((a, b) => b.pages - a.pages || a.key.localeCompare(b.key));
}

export interface ChoiceSummary {
  value: string;
  pages: number;
}

export function summarizeChoices(pages: readonly PageObject[], key: string): ChoiceSummary[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const choice of new Set(fieldChoices(fieldOf(page, key)))) {
      counts.set(choice, (counts.get(choice) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([value, count]) => ({ value, pages: count }))
    .sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
}

export const TITLE_COLUMN = '@title';
export const MODIFIED_COLUMN = '@modified';
export const NO_VALUE = '@none';

export interface TableView {
  filterKey: string;
  filterValue: string;
  search: string;
  sortKey: string;
  descending: boolean;
  columns: string[] | null;
}

export const EMPTY_TABLE_VIEW: TableView = {
  filterKey: '',
  filterValue: '',
  search: '',
  sortKey: TITLE_COLUMN,
  descending: false,
  columns: null,
};

export function hasFields(page: PageObject): boolean {
  return Object.keys(page.fields).some((key) => fieldChoices(fieldOf(page, key)).length > 0);
}

export function matchesFilter(page: PageObject, filterKey: string, filterValue: string): boolean {
  if (filterKey === '') return true;
  const choices = fieldChoices(fieldOf(page, filterKey));
  if (filterValue === '') return choices.length > 0;
  if (filterValue === NO_VALUE) return choices.length === 0;
  return choices.includes(filterValue);
}

function matchesSearch(page: PageObject, wanted: string): boolean {
  if (wanted === '') return true;
  if (page.title.toLowerCase().includes(wanted) || page.docName.toLowerCase().includes(wanted)) {
    return true;
  }
  for (const value of Object.values(page.fields)) {
    if (fieldText(value).toLowerCase().includes(wanted)) return true;
  }
  return false;
}

export function filterPages(pages: readonly PageObject[], view: TableView): PageObject[] {
  const wanted = view.search.trim().toLowerCase();
  return pages.filter(
    (page) =>
      hasFields(page) &&
      matchesFilter(page, view.filterKey, view.filterValue) &&
      matchesSearch(page, wanted),
  );
}

export function compareCells(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function sortValue(page: PageObject, column: string): FieldValue | undefined {
  if (column === TITLE_COLUMN) return page.title;
  if (column === MODIFIED_COLUMN) return page.modified;
  return fieldOf(page, column);
}

export function sortPages(pages: readonly PageObject[], view: TableView): PageObject[] {
  const direction = view.descending ? -1 : 1;
  return [...pages].sort((a, b) => {
    const left = sortValue(a, view.sortKey);
    const right = sortValue(b, view.sortKey);
    const leftText = fieldText(left);
    const rightText = fieldText(right);
    let order: number;
    if (leftText === '' || rightText === '') {
      order = compareCells(leftText, rightText);
    } else if (typeof left === 'number' && typeof right === 'number') {
      order = direction * (left - right);
    } else {
      order = direction * compareCells(leftText, rightText);
    }
    return order || a.docName.localeCompare(b.docName);
  });
}

export function defaultColumns(pages: readonly PageObject[], limit = 5): string[] {
  return summarizeFields(pages)
    .filter((field) => field.key !== 'title')
    .slice(0, limit)
    .map((field) => field.key);
}

export function tableColumns(pages: readonly PageObject[], view: TableView): string[] {
  if (view.columns === null) return defaultColumns(pages);
  const known = new Set(summarizeFields(pages).map((field) => field.key));
  return view.columns.filter((column) => known.has(column));
}

export function normalizeTableView(pages: readonly PageObject[], view: TableView): TableView {
  const known = new Set(summarizeFields(pages).map((field) => field.key));
  const filterKey = known.has(view.filterKey) ? view.filterKey : '';
  const values = new Set(summarizeChoices(pages, filterKey).map((choice) => choice.value));
  const knownValue = view.filterValue === NO_VALUE || values.has(view.filterValue);
  const keepValue = filterKey !== '' && knownValue;
  const columns = tableColumns(pages, view);
  const sortable = view.sortKey === TITLE_COLUMN || view.sortKey === MODIFIED_COLUMN;
  return {
    ...view,
    filterKey,
    filterValue: keepValue ? view.filterValue : '',
    sortKey: sortable || columns.includes(view.sortKey) ? view.sortKey : TITLE_COLUMN,
  };
}

export function readTableView(raw: string | null): TableView {
  if (raw === null) return EMPTY_TABLE_VIEW;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_TABLE_VIEW;
    const saved = parsed as Record<string, unknown>;
    const text = (value: unknown, fallback: string): string =>
      typeof value === 'string' ? value : fallback;
    return {
      filterKey: text(saved.filterKey, ''),
      filterValue: text(saved.filterValue, ''),
      search: '',
      sortKey: text(saved.sortKey, TITLE_COLUMN),
      descending: saved.descending === true,
      columns: Array.isArray(saved.columns)
        ? saved.columns.filter((column): column is string => typeof column === 'string')
        : null,
    };
  } catch {
    return EMPTY_TABLE_VIEW;
  }
}

export function writeTableView(view: TableView): string {
  return JSON.stringify({ ...view, search: '' });
}
