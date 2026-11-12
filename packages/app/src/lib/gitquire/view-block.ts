import {
  type ActionFilter,
  type ActionGrouping,
  BOARD_CLIENT_NAME,
  type BoardView,
  UNASSIGNED,
} from './board';
import { type ApiDeps, GitQuireApiError, gitquireRequest } from './branch-api';
import {
  EMPTY_TABLE_VIEW,
  MODIFIED_COLUMN,
  NO_VALUE,
  type TableView,
  TITLE_COLUMN,
} from './objects';
import type { TimelineView } from './timeline';

export const VIEW_BLOCK_LANGUAGE = 'gitquire-view';
export const SAVED_VIEW_FOLDER = 'views';

export type ViewKind = 'table' | 'board' | 'timeline' | 'actions';

const KINDS: readonly ViewKind[] = ['table', 'board', 'timeline', 'actions'];
const GROUPINGS: readonly ActionGrouping[] = ['page', 'due', 'person'];
const NONE_WORD = '(none)';
const MAX_LINES = 50;
const MAX_VALUE_CHARS = 200;
const LINE_RE = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/;
const FILTER_RE = /^(.+?)\s*=\s*(.*)$/;
const SORT_RE = /^(.*?)(?:\s+(asc|desc))?$/i;

export interface ViewSpec {
  view: ViewKind;
  filterKey: string;
  filterValue: string;
  search: string;
  columns: string[] | null;
  sortKey: string;
  descending: boolean;
  group: string;
  dateKey: string;
  person: string;
  showDone: boolean;
}

export const DEFAULT_VIEW_SPEC: ViewSpec = {
  view: 'table',
  filterKey: '',
  filterValue: '',
  search: '',
  columns: null,
  sortKey: TITLE_COLUMN,
  descending: false,
  group: '',
  dateKey: '',
  person: '',
  showDone: false,
};

function sortKeyFrom(word: string): string {
  const lower = word.toLowerCase();
  if (lower === 'title' || lower === '') return TITLE_COLUMN;
  if (lower === 'changed' || lower === 'modified') return MODIFIED_COLUMN;
  return word;
}

function sortWord(key: string): string {
  if (key === TITLE_COLUMN) return 'title';
  if (key === MODIFIED_COLUMN) return 'changed';
  return key;
}

function personFrom(word: string): string {
  const lower = word.toLowerCase();
  if (lower === 'nobody') return UNASSIGNED;
  return lower.startsWith('@') ? lower.slice(1) : lower;
}

export function parseViewBlock(source: string): ViewSpec {
  const spec: ViewSpec = { ...DEFAULT_VIEW_SPEC };
  for (const line of source.split('\n').slice(0, MAX_LINES)) {
    const match = LINE_RE.exec(line);
    if (match === null) continue;
    const key = (match[1] as string).toLowerCase();
    const value = (match[2] as string).slice(0, MAX_VALUE_CHARS);
    if (key === 'view') {
      const kind = value.toLowerCase();
      if ((KINDS as readonly string[]).includes(kind)) spec.view = kind as ViewKind;
    } else if (key === 'filter') {
      const filter = FILTER_RE.exec(value);
      if (filter !== null) {
        spec.filterKey = (filter[1] as string).trim();
        const wanted = (filter[2] as string).trim();
        spec.filterValue = wanted === NONE_WORD ? NO_VALUE : wanted;
      } else {
        spec.filterKey = value;
      }
    } else if (key === 'search') {
      spec.search = value;
    } else if (key === 'columns') {
      const columns = value
        .split(',')
        .map((column) => column.trim())
        .filter((column) => column !== '');
      spec.columns = columns.length === 0 ? null : columns;
    } else if (key === 'sort') {
      const sort = SORT_RE.exec(value);
      spec.sortKey = sortKeyFrom((sort?.[1] ?? '').trim());
      spec.descending = sort?.[2]?.toLowerCase() === 'desc';
    } else if (key === 'group') {
      spec.group = value;
    } else if (key === 'date') {
      spec.dateKey = value;
    } else if (key === 'person') {
      spec.person = personFrom(value);
    } else if (key === 'done') {
      spec.showDone = ['show', 'yes', 'true'].includes(value.toLowerCase());
    }
  }
  return spec;
}

function filterLine(spec: ViewSpec): string | undefined {
  if (spec.filterKey === '') return undefined;
  if (spec.filterValue === '') return `filter: ${spec.filterKey}`;
  const value = spec.filterValue === NO_VALUE ? NONE_WORD : spec.filterValue;
  return `filter: ${spec.filterKey} = ${value}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function writeViewBlock(spec: ViewSpec): string {
  const lines = [`view: ${spec.view}`];
  const filter = filterLine(spec);
  if (filter !== undefined) lines.push(oneLine(filter));
  if (spec.search.trim() !== '') lines.push(`search: ${oneLine(spec.search)}`);
  if (spec.view === 'table') {
    if (spec.columns !== null) lines.push(`columns: ${spec.columns.map(oneLine).join(', ')}`);
    const direction = spec.descending ? ' desc' : '';
    if (spec.sortKey !== TITLE_COLUMN || spec.descending) {
      lines.push(`sort: ${oneLine(sortWord(spec.sortKey))}${direction}`);
    }
  }
  if ((spec.view === 'board' || spec.view === 'actions') && spec.group !== '') {
    lines.push(`group: ${oneLine(spec.group)}`);
  }
  if (spec.view === 'timeline' && spec.dateKey !== '') lines.push(`date: ${oneLine(spec.dateKey)}`);
  if (spec.view === 'actions') {
    if (spec.person !== '') {
      lines.push(`person: ${spec.person === UNASSIGNED ? 'nobody' : `@${spec.person}`}`);
    }
    if (spec.showDone) lines.push('done: show');
  }
  return lines.join('\n');
}

export function tableViewOf(spec: ViewSpec): TableView {
  return {
    ...EMPTY_TABLE_VIEW,
    filterKey: spec.filterKey,
    filterValue: spec.filterValue,
    search: spec.search,
    sortKey: spec.sortKey,
    descending: spec.descending,
    columns: spec.columns,
  };
}

export function boardViewOf(spec: ViewSpec): BoardView {
  return { groupKey: spec.group, filterKey: spec.filterKey, filterValue: spec.filterValue };
}

export function timelineViewOf(spec: ViewSpec): TimelineView {
  return {
    dateKey: spec.dateKey,
    filterKey: spec.filterKey,
    filterValue: spec.filterValue,
    search: spec.search,
  };
}

export function actionFilterOf(spec: ViewSpec): ActionFilter {
  const grouping = (GROUPINGS as readonly string[]).includes(spec.group)
    ? (spec.group as ActionGrouping)
    : 'page';
  return { person: spec.person, showDone: spec.showDone, search: spec.search, grouping };
}

export function specFromTable(view: TableView): ViewSpec {
  return { ...DEFAULT_VIEW_SPEC, ...view, view: 'table' };
}

export function specFromBoard(view: BoardView): ViewSpec {
  return {
    ...DEFAULT_VIEW_SPEC,
    view: 'board',
    filterKey: view.filterKey,
    filterValue: view.filterValue,
    group: view.groupKey,
  };
}

export function specFromTimeline(view: TimelineView): ViewSpec {
  return {
    ...DEFAULT_VIEW_SPEC,
    view: 'timeline',
    filterKey: view.filterKey,
    filterValue: view.filterValue,
    search: view.search,
    dateKey: view.dateKey,
  };
}

export function specFromActions(filter: ActionFilter): ViewSpec {
  return {
    ...DEFAULT_VIEW_SPEC,
    view: 'actions',
    search: filter.search,
    person: filter.person,
    showDone: filter.showDone,
    group: filter.grouping ?? 'page',
  };
}

export function savedViewMarkdown(title: string, spec: ViewSpec): string {
  return `# ${oneLine(title)}\n\n\`\`\`${VIEW_BLOCK_LANGUAGE}\n${writeViewBlock(spec)}\n\`\`\`\n`;
}

export function savedViewDocName(name: string): string | undefined {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug === '' ? undefined : `${SAVED_VIEW_FOLDER}/${slug}`;
}

export class PageExistsError extends Error {
  constructor() {
    super('A page with that name exists.');
    this.name = 'PageExistsError';
  }
}

export async function saveViewAsPage(
  title: string,
  spec: ViewSpec,
  deps: ApiDeps = {},
): Promise<string> {
  const docName = savedViewDocName(title);
  if (docName === undefined) throw new PageExistsError();
  try {
    const body = { path: `${docName}.md` };
    await gitquireRequest('/api/create-page', { method: 'POST', body }, deps);
  } catch (err) {
    if (err instanceof GitQuireApiError && err.status === 409) throw new PageExistsError();
    throw err;
  }
  await gitquireRequest(
    '/api/agent-write-md',
    {
      method: 'POST',
      body: {
        docName,
        markdown: savedViewMarkdown(title, spec),
        position: 'replace',
        summary: `Save view ${oneLine(title)}`.slice(0, 200),
        clientName: BOARD_CLIENT_NAME,
      },
    },
    deps,
  );
  return docName;
}
