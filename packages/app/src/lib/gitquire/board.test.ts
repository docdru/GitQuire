import { describe, expect, test } from 'vitest';
import {
  actionItems,
  actionPeople,
  applyPendingMoves,
  BOARD_CLIENT_NAME,
  boardGroupKeys,
  buildBoard,
  EMPTY_BOARD_VIEW,
  filterActionItems,
  groupActionItems,
  movePage,
  readBoardView,
  setPageField,
  stageRank,
  UNASSIGNED,
} from './board';
import type { PageObject, PageTask } from './objects';

function page(docName: string, fields: PageObject['fields'], tasks: PageTask[] = []): PageObject {
  return { docName, path: `${docName}.md`, title: docName, modified: '2026-11-10', fields, tasks };
}

function task(text: string, line: number, done = false, mentions: string[] = []): PageTask {
  return { id: `t${line}`, text, done, line, mentions };
}

const budgetReview = task('Review budget @bob @alice', 3, false, ['bob', 'alice']);

const pages = [
  page('tasks/b', { type: 'task', status: 'Doing', owner: 'alice', tags: ['web'] }),
  page('tasks/a', { type: 'task', status: 'Doing', owner: 'bob' }),
  page('tasks/c', { type: 'task', status: 'To do', owner: 'bob' }),
  page('tasks/d', { type: 'task', status: 'Done', owner: 'alice' }),
  page('tasks/e', { type: 'task', owner: 'carol' }),
  page('decisions/x', { type: 'decision', status: 'Accepted' }),
  page('notes/meeting', {}, [
    task('Send the notes @bob', 5, false, ['bob']),
    task('Book a room', 6),
    task('Order lunch @alice', 7, true, ['alice']),
  ]),
  page('notes/plan', { type: 'note' }, [budgetReview]),
];

function shape(board: ReturnType<typeof buildBoard>): [string, string[]][] {
  return (board?.columns ?? []).map((column) => [
    column.value,
    column.pages.map((item) => item.docName),
  ]);
}

describe('board', () => {
  test('offers fields with a handful of plain values, status first', () => {
    expect(boardGroupKeys(pages)).toEqual(['status', 'owner', 'type']);
  });

  test('orders stages the way work flows', () => {
    expect(stageRank('Backlog')).toBeLessThan(stageRank('To do'));
    expect(stageRank('to do')).toBeLessThan(stageRank(' In progress '));
    expect(stageRank('Custom')).toBeLessThan(stageRank('Done'));
    expect(stageRank('Custom')).toBeGreaterThan(stageRank('Doing'));
  });

  test('groups pages into columns and keeps empty columns as targets', () => {
    expect(shape(buildBoard(pages, EMPTY_BOARD_VIEW))).toEqual([
      ['To do', ['tasks/c']],
      ['Doing', ['tasks/a', 'tasks/b']],
      ['Accepted', ['decisions/x']],
      ['Done', ['tasks/d']],
    ]);
    const tasksOnly = { groupKey: 'status', filterKey: 'type', filterValue: 'task' };
    expect(shape(buildBoard(pages, tasksOnly))).toEqual([
      ['', ['tasks/e']],
      ['To do', ['tasks/c']],
      ['Doing', ['tasks/a', 'tasks/b']],
      ['Accepted', []],
      ['Done', ['tasks/d']],
    ]);
    const byOwner = buildBoard(pages, { groupKey: 'owner', filterKey: '', filterValue: '' });
    expect(byOwner?.groupKey).toBe('owner');
    expect(shape(byOwner).map(([value]) => value)).toEqual(['alice', 'bob', 'carol']);
  });

  test('falls back to the first usable field, or says there is none', () => {
    expect(buildBoard(pages, { ...EMPTY_BOARD_VIEW, groupKey: 'gone' })?.groupKey).toBe('status');
    expect(buildBoard([page('a', { title: 'Only one' })], EMPTY_BOARD_VIEW)).toBeNull();
  });

  test('moves a page to another column, or out of all of them', () => {
    const moved = movePage(pages, 'tasks/c', 'status', 'Done');
    expect(moved.find((item) => item.docName === 'tasks/c')?.fields.status).toBe('Done');
    expect(pages.find((item) => item.docName === 'tasks/c')?.fields.status).toBe('To do');
    const cleared = movePage(pages, 'tasks/c', 'status', null);
    expect(cleared.find((item) => item.docName === 'tasks/c')?.fields).toEqual({
      type: 'task',
      owner: 'bob',
    });
  });

  test('sends a move to the server as a property change', async () => {
    const bodies: unknown[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      bodies.push([String(url), init?.method, JSON.parse(String(init?.body))]);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await setPageField('tasks/c', 'status', 'Done', { fetch: fake });
    await setPageField('tasks/c', 'status', null, { fetch: fake });
    await setPageField('tasks/c', 'prio', 2, { fetch: fake });
    const board = { clientName: BOARD_CLIENT_NAME };
    expect(bodies).toEqual([
      [
        '/api/frontmatter-patch',
        'POST',
        { docName: 'tasks/c', patch: { status: 'Done' }, summary: 'Set status to Done', ...board },
      ],
      [
        '/api/frontmatter-patch',
        'POST',
        { docName: 'tasks/c', patch: { status: null }, summary: 'Clear status', ...board },
      ],
      [
        '/api/frontmatter-patch',
        'POST',
        { docName: 'tasks/c', patch: { prio: 2 }, summary: 'Set prio to 2', ...board },
      ],
    ]);
  });

  test('keeps its columns and grouping while moves are pending', () => {
    const two = [page('a', { status: 'To do' }), page('b', { status: 'Done' })];
    const afterMove = movePage(two, 'a', 'status', 'Done');
    const view = { ...EMPTY_BOARD_VIEW, groupKey: 'status' };
    expect(buildBoard(afterMove, EMPTY_BOARD_VIEW)).toBeNull();
    expect(shape(buildBoard(two, view, afterMove))).toEqual([
      ['To do', []],
      ['Done', ['a', 'b']],
    ]);
    expect(shape(buildBoard(afterMove, view))).toEqual([['Done', ['a', 'b']]]);
  });

  test('keeps numbers and true or false as they are', () => {
    const typed = [page('a', { prio: 1 }), page('b', { prio: 2 }), page('c', { prio: 2 })];
    const board = buildBoard(typed, EMPTY_BOARD_VIEW);
    expect(board?.columns.map((column) => column.raw)).toEqual([1, 2]);
    const flags = [page('a', { urgent: true }), page('b', { urgent: false })];
    expect(buildBoard(flags, EMPTY_BOARD_VIEW)?.columns.map((column) => column.raw)).toEqual([
      false,
      true,
    ]);
  });

  test('treats an empty value as no value and never offers the title', () => {
    const mixed = [
      page('a', { type: 'task', status: '', title: 'A' }),
      page('b', { type: 'task', status: 'Done', title: 'B' }),
      page('c', { type: 'task', status: 'To do', title: 'C' }),
    ];
    expect(boardGroupKeys(mixed)).toEqual(['status']);
    const tasks = { groupKey: 'status', filterKey: 'type', filterValue: 'task' };
    expect(shape(buildBoard(mixed, tasks))).toEqual([
      ['', ['a']],
      ['To do', ['c']],
      ['Done', ['b']],
    ]);
    expect(shape(buildBoard(mixed, EMPTY_BOARD_VIEW)).map(([value]) => value)).toEqual([
      'To do',
      'Done',
    ]);
  });

  test('applies moves that are still on their way to the server', () => {
    const pending = new Map([['tasks/c', { key: 'status', value: 'Done' }]]);
    const shown = applyPendingMoves(pages, pending);
    expect(shown.find((item) => item.docName === 'tasks/c')?.fields.status).toBe('Done');
    expect(applyPendingMoves(pages, new Map())).toEqual(pages);
  });

  test('restores a saved board and survives bad data', () => {
    expect(readBoardView('{"groupKey":"owner","filterKey":7}')).toEqual({
      groupKey: 'owner',
      filterKey: '',
      filterValue: '',
    });
    expect(readBoardView('nope')).toEqual(EMPTY_BOARD_VIEW);
    expect(readBoardView(null)).toEqual(EMPTY_BOARD_VIEW);
  });
});

describe('action items', () => {
  const items = actionItems(pages);
  const open = { person: '', showDone: false, search: '' };

  test('are collected from every page', () => {
    expect(items.map((item) => item.id)).toEqual([
      'notes/meeting#t5',
      'notes/meeting#t6',
      'notes/meeting#t7',
      'notes/plan#t3',
    ]);
  });

  test('filter by state, person and text', () => {
    expect(filterActionItems(items, open)).toHaveLength(3);
    expect(filterActionItems(items, { ...open, showDone: true })).toHaveLength(4);
    const forBob = filterActionItems(items, { ...open, person: 'Bob' });
    expect(forBob.map((item) => item.line)).toEqual([5, 3]);
    const nobody = filterActionItems(items, { ...open, person: UNASSIGNED });
    expect(nobody.map((item) => item.text)).toEqual(['Book a room']);
    expect(filterActionItems(items, { ...open, search: 'BUDGET' })).toHaveLength(1);
    expect(filterActionItems(items, { ...open, search: 'meeting' })).toHaveLength(2);
  });

  test('count open items per person', () => {
    expect(actionPeople(items)).toEqual([
      { login: 'bob', open: 2 },
      { login: 'alice', open: 1 },
    ]);
  });

  test('are grouped by page', () => {
    const groups = groupActionItems(filterActionItems(items, open));
    expect(groups.map((group) => [group.docName, group.items.length])).toEqual([
      ['notes/meeting', 2],
      ['notes/plan', 1],
    ]);
  });
});
