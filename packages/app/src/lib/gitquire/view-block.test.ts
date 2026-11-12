import { describe, expect, test } from 'vitest';
import { BOARD_CLIENT_NAME, UNASSIGNED } from './board';
import { MODIFIED_COLUMN, NO_VALUE, TITLE_COLUMN } from './objects';
import {
  actionFilterOf,
  boardViewOf,
  DEFAULT_VIEW_SPEC,
  PageExistsError,
  parseViewBlock,
  savedViewDocName,
  savedViewMarkdown,
  saveViewAsPage,
  specFromActions,
  specFromBoard,
  specFromTable,
  tableViewOf,
  timelineViewOf,
  writeViewBlock,
} from './view-block';

describe('saved view blocks', () => {
  test('read a board', () => {
    const spec = parseViewBlock('view: board\nfilter: type = task\ngroup: status\n');
    expect(boardViewOf(spec)).toEqual({
      groupKey: 'status',
      filterKey: 'type',
      filterValue: 'task',
    });
  });

  test('read a table with columns and sorting', () => {
    const lines = ['view: Table', 'filter: owner = (none)', 'columns: status, owner'];
    const spec = parseViewBlock([...lines, 'sort: changed desc'].join('\n'));
    expect(tableViewOf(spec)).toMatchObject({
      filterKey: 'owner',
      filterValue: NO_VALUE,
      columns: ['status', 'owner'],
      sortKey: MODIFIED_COLUMN,
      descending: true,
    });
  });

  test('read a timeline and action items', () => {
    expect(timelineViewOf(parseViewBlock('view: timeline\ndate: held\nsearch: launch'))).toEqual({
      dateKey: 'held',
      filterKey: '',
      filterValue: '',
      search: 'launch',
    });
    const actions = parseViewBlock('view: actions\ngroup: due\nperson: @Bob\ndone: show');
    expect(actionFilterOf(actions)).toEqual({
      person: 'bob',
      showDone: true,
      search: '',
      grouping: 'due',
    });
    expect(parseViewBlock('view: actions\nperson: nobody').person).toBe(UNASSIGNED);
    expect(actionFilterOf(parseViewBlock('view: actions\ngroup: status')).grouping).toBe('page');
  });

  test('ignore what they do not know', () => {
    expect(parseViewBlock('view: chart\nnonsense\ncolor: red')).toEqual(DEFAULT_VIEW_SPEC);
  });

  test('write what they read', () => {
    const board = specFromBoard({ groupKey: 'status', filterKey: 'type', filterValue: 'task' });
    expect(writeViewBlock(board)).toBe('view: board\nfilter: type = task\ngroup: status');
    expect(parseViewBlock(writeViewBlock(board))).toEqual(board);
    const table = specFromTable({
      filterKey: 'owner',
      filterValue: NO_VALUE,
      search: '',
      sortKey: TITLE_COLUMN,
      descending: true,
      columns: ['status'],
    });
    expect(writeViewBlock(table)).toBe(
      'view: table\nfilter: owner = (none)\ncolumns: status\nsort: title desc',
    );
    expect(parseViewBlock(writeViewBlock(table))).toEqual(table);
    const actions = specFromActions({
      person: UNASSIGNED,
      showDone: true,
      search: 'notes',
      grouping: 'person',
    });
    expect(parseViewBlock(writeViewBlock(actions))).toEqual(actions);
  });

  test('keep a value on one line', () => {
    const spec = { ...DEFAULT_VIEW_SPEC, search: 'a\n```\nb' };
    expect(writeViewBlock(spec)).toBe('view: table\nsearch: a ``` b');
  });

  test('name the page in the views folder', () => {
    expect(savedViewDocName('Open tasks!')).toBe('views/open-tasks');
    expect(savedViewDocName('  ')).toBeUndefined();
    const board = specFromBoard({ groupKey: 'status', filterKey: '', filterValue: '' });
    expect(savedViewMarkdown('Open tasks', board)).toBe(
      '# Open tasks\n\n```gitquire-view\nview: board\ngroup: status\n```\n',
    );
  });

  test('save a new page and refuse to overwrite one', async () => {
    const calls: [string, unknown][] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), JSON.parse(String(init?.body))]);
      return new Response('{"docName":"views/open-tasks"}', { status: 200 });
    }) as typeof fetch;
    expect(await saveViewAsPage('Open tasks', DEFAULT_VIEW_SPEC, { fetch: fake })).toBe(
      'views/open-tasks',
    );
    expect(calls[0]).toEqual(['/api/create-page', { path: 'views/open-tasks.md' }]);
    expect(calls[1]?.[1]).toMatchObject({ position: 'replace', clientName: BOARD_CLIENT_NAME });
    const taken = (async () => new Response('{}', { status: 409 })) as typeof fetch;
    const again = saveViewAsPage('Open tasks', DEFAULT_VIEW_SPEC, { fetch: taken });
    await expect(again).rejects.toBeInstanceOf(PageExistsError);
  });
});
