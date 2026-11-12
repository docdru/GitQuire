import { describe, expect, test } from 'vitest';
import {
  compareCells,
  defaultColumns,
  EMPTY_TABLE_VIEW,
  fetchObjects,
  fieldChoices,
  fieldText,
  filterPages,
  MODIFIED_COLUMN,
  NO_VALUE,
  normalizeTableView,
  type PageObject,
  readTableView,
  sortPages,
  summarizeChoices,
  summarizeFields,
  type TableView,
  TITLE_COLUMN,
  tableColumns,
  writeTableView,
} from './objects';

function page(docName: string, fields: PageObject['fields'], modified = '2026-11-10'): PageObject {
  const title = typeof fields.title === 'string' ? fields.title : docName;
  return { docName, path: `${docName}.md`, title, modified, fields, tasks: [] };
}

const NEWER = '2026-11-11';

const pages = [
  page('tasks/landing', { type: 'task', status: 'Doing', owner: 'alice', estimate: 3 }),
  page('tasks/pricing', { type: 'task', status: 'To do', owner: 'bob', tags: ['web', 'q4'] }),
  page('decisions/hosting', { type: 'decision', status: 'Accepted', date: '2026-10-02' }, NEWER),
  page('tasks/unsorted', { type: 'task', estimate: 10 }),
  page('notes/plain', {}),
];

function view(changes: Partial<TableView>): TableView {
  return { ...EMPTY_TABLE_VIEW, ...changes };
}

function names(list: readonly PageObject[]): string[] {
  return list.map((item) => item.docName);
}

describe('field values', () => {
  test('are shown as text', () => {
    expect(fieldText('Doing')).toBe('Doing');
    expect(fieldText(3)).toBe('3');
    expect(fieldText(false)).toBe('false');
    expect(fieldText(null)).toBe('');
    expect(fieldText(undefined)).toBe('');
    expect(fieldText(['web', 'q4'])).toBe('web, q4');
    expect(fieldText({ a: 1 })).toBe('{"a":1}');
  });

  test('offer one choice per list item', () => {
    expect(fieldChoices(['web', '', 'q4'])).toEqual(['web', 'q4']);
    expect(fieldChoices('Doing')).toEqual(['Doing']);
    expect(fieldChoices(null)).toEqual([]);
  });
});

describe('summaries', () => {
  test('rank fields by how many pages have them', () => {
    expect(summarizeFields(pages).slice(0, 3)).toEqual([
      { key: 'type', pages: 4 },
      { key: 'status', pages: 3 },
      { key: 'estimate', pages: 2 },
    ]);
    expect(defaultColumns(pages, 2)).toEqual(['type', 'status']);
  });

  test('count the values of a field, list items separately', () => {
    expect(summarizeChoices(pages, 'status')).toEqual([
      { value: 'Accepted', pages: 1 },
      { value: 'Doing', pages: 1 },
      { value: 'To do', pages: 1 },
    ]);
    expect(summarizeChoices(pages, 'tags').map((choice) => choice.value)).toEqual(['q4', 'web']);
  });
});

describe('table', () => {
  test('lists only pages with fields', () => {
    expect(names(filterPages(pages, EMPTY_TABLE_VIEW))).not.toContain('notes/plain');
    expect(filterPages(pages, EMPTY_TABLE_VIEW)).toHaveLength(4);
  });

  test('filters by a field value, by a missing value and by text', () => {
    const tasks = filterPages(pages, view({ filterKey: 'type', filterValue: 'task' }));
    expect(tasks).toHaveLength(3);
    const web = filterPages(pages, view({ filterKey: 'tags', filterValue: 'web' }));
    expect(names(web)).toEqual(['tasks/pricing']);
    const anyStatus = filterPages(pages, view({ filterKey: 'status', filterValue: '' }));
    expect(anyStatus).toHaveLength(3);
    const noStatus = filterPages(pages, view({ filterKey: 'status', filterValue: NO_VALUE }));
    expect(names(noStatus)).toEqual(['tasks/unsorted']);
    expect(names(filterPages(pages, view({ search: ' ALICE ' })))).toEqual(['tasks/landing']);
    expect(names(filterPages(pages, view({ search: 'hosting' })))).toEqual(['decisions/hosting']);
  });

  test('sorts by a column with numbers in order and empty cells last', () => {
    const listed = filterPages(pages, EMPTY_TABLE_VIEW);
    const byEstimate = sortPages(listed, view({ sortKey: 'estimate' }));
    expect(names(byEstimate).slice(0, 2)).toEqual(['tasks/landing', 'tasks/unsorted']);
    const descending = view({ sortKey: 'estimate', descending: true });
    const byEstimateDown = sortPages(listed, descending);
    expect(names(byEstimateDown).slice(0, 2)).toEqual(['tasks/unsorted', 'tasks/landing']);
    expect(names(byEstimateDown).slice(2)).toEqual(['decisions/hosting', 'tasks/pricing']);
    const newest = view({ sortKey: MODIFIED_COLUMN, descending: true });
    expect(names(sortPages(pages, newest))[0]).toBe('decisions/hosting');
    expect(compareCells('item 2', 'item 10')).toBeLessThan(0);
  });

  test('sorts negative and decimal numbers by value', () => {
    const numbers = [
      page('a', { n: -5 }),
      page('b', { n: -10 }),
      page('c', { n: 1.5 }),
      page('d', { n: 1.25 }),
    ];
    expect(names(sortPages(numbers, view({ sortKey: 'n' })))).toEqual(['b', 'a', 'd', 'c']);
  });

  test('treats property names that objects inherit like any other name', () => {
    const odd = [page('a', { type: 'task' }), page('b', { type: 'task', toString: 'yes' })];
    expect(summarizeChoices(odd, 'toString')).toEqual([{ value: 'yes', pages: 1 }]);
    expect(names(sortPages(odd, view({ sortKey: 'toString' })))).toEqual(['b', 'a']);
    const missing = filterPages(odd, view({ filterKey: 'toString', filterValue: NO_VALUE }));
    expect(names(missing)).toEqual(['a']);
    expect(fieldText(Object.prototype.toString as unknown as string)).toBe('');
  });

  test('drops a saved filter, value or sort column that the pages no longer have', () => {
    const gone = { filterKey: 'gone', filterValue: 'x', sortKey: 'gone' };
    const stale = view({ ...gone, columns: ['owner'] });
    expect(normalizeTableView(pages, stale)).toEqual(view({ columns: ['owner'] }));
    const staleValue = view({ filterKey: 'status', filterValue: 'Archived', sortKey: 'tags' });
    expect(normalizeTableView(pages, staleValue)).toEqual(
      view({ filterKey: 'status', filterValue: '', sortKey: TITLE_COLUMN }),
    );
    const fine = view({ filterKey: 'status', filterValue: NO_VALUE, sortKey: 'status' });
    expect(normalizeTableView(pages, fine)).toEqual(fine);
  });

  test('uses the chosen columns that still exist, and the most common ones by default', () => {
    expect(tableColumns(pages, view({ columns: ['owner', 'gone'] }))).toEqual(['owner']);
    expect(tableColumns(pages, view({ columns: [] }))).toEqual([]);
    expect(tableColumns(pages, EMPTY_TABLE_VIEW)).toEqual(defaultColumns(pages));
  });

  test('restores a saved view and survives bad data', () => {
    const saved = JSON.stringify({ filterKey: 'type', filterValue: 'task', columns: ['owner', 7] });
    expect(readTableView(saved)).toEqual(
      view({ filterKey: 'type', filterValue: 'task', columns: ['owner'] }),
    );
    expect(readTableView('{broken')).toEqual(EMPTY_TABLE_VIEW);
    const typed = view({ search: 'typing', columns: ['owner'] });
    expect(readTableView(writeTableView(typed))).toEqual(view({ columns: ['owner'] }));
    expect(readTableView(null)).toEqual(EMPTY_TABLE_VIEW);
  });
});

describe('fetchObjects', () => {
  test('asks the server for the list', async () => {
    const answer = { pages, truncated: false };
    const fake = (async (url: string | URL | Request) => {
      expect(String(url)).toBe('/api/gitquire/objects');
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    expect((await fetchObjects({ fetch: fake })).pages).toHaveLength(5);
  });
});
