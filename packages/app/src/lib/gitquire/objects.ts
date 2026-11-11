import { type ApiDeps, gitquireRequest } from './branch-api';

export type FieldValue =
  | string
  | number
  | boolean
  | null
  | FieldValue[]
  | { [key: string]: FieldValue };

export interface PageTask {
  text: string;
  done: boolean;
  line: number;
  mentions: string[];
}

export interface PageObject {
  docName: string;
  path: string;
  title: string;
  modified: string;
  fields: Record<string, FieldValue>;
  tasks: PageTask[];
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
  if (Array.isArray(value)) return value.map(fieldText).join(', ');
  return JSON.stringify(value);
}

export function fieldChoices(value: FieldValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map(fieldText).filter((text) => text !== '');
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
    for (const choice of new Set(fieldChoices(page.fields[key]))) {
      counts.set(choice, (counts.get(choice) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([value, count]) => ({ value, pages: count }))
    .sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
}

export const TITLE_COLUMN = '@title';
export const MODIFIED_COLUMN = '@modified';

export interface TableView {
  filterKey: string;
  filterValue: string;
  search: string;
  sortKey: string;
  descending: boolean;
  columns: string[];
}

export const EMPTY_TABLE_VIEW: TableView = {
  filterKey: '',
  filterValue: '',
  search: '',
  sortKey: TITLE_COLUMN,
  descending: false,
  columns: [],
};

function cellText(page: PageObject, column: string): string {
  if (column === TITLE_COLUMN) return page.title;
  if (column === MODIFIED_COLUMN) return page.modified;
  return fieldText(page.fields[column]);
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
  return pages.filter((page) => {
    if (Object.keys(page.fields).length === 0) return false;
    if (view.filterKey !== '') {
      const choices = fieldChoices(page.fields[view.filterKey]);
      if (view.filterValue === '' ? choices.length === 0 : !choices.includes(view.filterValue)) {
        return false;
      }
    }
    return matchesSearch(page, wanted);
  });
}

export function compareCells(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortPages(pages: readonly PageObject[], view: TableView): PageObject[] {
  const direction = view.descending ? -1 : 1;
  return [...pages].sort((a, b) => {
    const left = cellText(a, view.sortKey);
    const right = cellText(b, view.sortKey);
    const order = compareCells(left, right);
    const directed = left === '' || right === '' ? order : direction * order;
    return directed || a.docName.localeCompare(b.docName);
  });
}

export function defaultColumns(pages: readonly PageObject[], limit = 5): string[] {
  return summarizeFields(pages)
    .filter((field) => field.key !== 'title')
    .slice(0, limit)
    .map((field) => field.key);
}

export function tableColumns(pages: readonly PageObject[], view: TableView): string[] {
  const known = new Set(summarizeFields(pages).map((field) => field.key));
  const chosen = view.columns.filter((column) => known.has(column));
  return chosen.length > 0 ? chosen : defaultColumns(pages);
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
        : [],
    };
  } catch {
    return EMPTY_TABLE_VIEW;
  }
}
