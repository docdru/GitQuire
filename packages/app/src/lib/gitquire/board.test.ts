import { describe, expect, test } from 'vitest';
import {
  actionItems,
  actionPeople,
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
    const cleared = movePage(pages, 'tasks/c', 'status', '');
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
    await setPageField('tasks/c', 'status', '', { fetch: fake });
    expect(bodies).toEqual([
      [
        '/api/frontmatter-patch',
        'POST',
        { docName: 'tasks/c', patch: { status: 'Done' }, summary: 'Set status to Done' },
      ],
      [
        '/api/frontmatter-patch',
        'POST',
        { docName: 'tasks/c', patch: { status: null }, summary: 'Clear status' },
      ],
    ]);
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
