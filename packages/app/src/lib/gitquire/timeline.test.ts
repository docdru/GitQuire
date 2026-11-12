import { describe, expect, test } from 'vitest';
import { BOARD_CLIENT_NAME } from './board';
import type { PageObject, PageTask } from './objects';
import {
  attendeesOf,
  buildTimeline,
  createMeetingNote,
  dateKeys,
  dayOf,
  EMPTY_TIMELINE_VIEW,
  IncompleteNoteError,
  readTimelineView,
} from './timeline';

function task(id: string, done: boolean): PageTask {
  return { id, text: id, done, line: 1, mentions: [] };
}

function page(
  docName: string,
  fields: PageObject['fields'],
  extra: Partial<PageObject> = {},
): PageObject {
  return {
    docName,
    path: `${docName}.md`,
    title: docName,
    modified: '2026-11-10',
    fields,
    tasks: [],
    ...extra,
  };
}

const pages = [
  page(
    'meeting-notes/2026-11-11',
    { type: 'meeting', date: '2026-11-11', attendees: ['DD', 'AK'] },
    { decisions: ['Store comments in the file'], tasks: [task('a', false), task('b', true)] },
  ),
  page('meeting-notes/2026-11-04', { type: 'meeting', date: '2026-11-04T10:00:00Z' }),
  page('meeting-notes/2026-10-28', { type: 'meeting', date: '2026-10-28', people: 'DD, MS' }),
  page('tasks/launch', { type: 'task', due: '2026-12-01' }),
  page('notes/bad', { type: 'meeting', date: '2026-02-30' }),
];

describe('timeline', () => {
  test('reads days from date properties only', () => {
    expect(dayOf('2026-11-11')).toBe('2026-11-11');
    expect(dayOf('2026-11-04T10:00:00Z')).toBe('2026-11-04');
    expect(dayOf('2026-02-30')).toBeUndefined();
    expect(dayOf('soon')).toBeUndefined();
    expect(dayOf(20261111)).toBeUndefined();
  });

  test('prefers a property called date', () => {
    expect(dateKeys(pages)).toEqual(['date', 'due']);
  });

  test('groups dated pages by month, newest first', () => {
    const months = buildTimeline(pages, EMPTY_TIMELINE_VIEW);
    expect(months.map((month) => [month.month, month.entries.map((entry) => entry.day)])).toEqual([
      ['2026-11', ['2026-11-11', '2026-11-04']],
      ['2026-10', ['2026-10-28']],
    ]);
    expect(months[0]?.entries[0]).toMatchObject({ open: 1, done: 1 });
  });

  test('filters and searches', () => {
    const due = buildTimeline(pages, { ...EMPTY_TIMELINE_VIEW, dateKey: 'due' });
    expect(due.map((month) => month.month)).toEqual(['2026-12']);
    const found = buildTimeline(pages, { ...EMPTY_TIMELINE_VIEW, search: 'comments' });
    expect(found.flatMap((month) => month.entries.map((entry) => entry.day))).toEqual([
      '2026-11-11',
    ]);
    const none = buildTimeline(pages, {
      ...EMPTY_TIMELINE_VIEW,
      filterKey: 'type',
      filterValue: 'task',
    });
    expect(none).toEqual([]);
  });

  test('reads attendees from a list or a comma list', () => {
    expect(attendeesOf(pages[0] as PageObject)).toEqual(['DD', 'AK']);
    expect(attendeesOf(pages[2] as PageObject)).toEqual(['DD', 'MS']);
    expect(attendeesOf(pages[3] as PageObject)).toEqual([]);
  });

  test('restores a saved view and survives bad data', () => {
    expect(readTimelineView('{"dateKey":"due","search":3}')).toEqual({
      ...EMPTY_TIMELINE_VIEW,
      dateKey: 'due',
    });
    expect(readTimelineView('nope')).toEqual(EMPTY_TIMELINE_VIEW);
  });

  test('creates a meeting note, or opens the one that exists', async () => {
    const calls: [string, unknown][] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), JSON.parse(String(init?.body))]);
      return new Response('{"docName":"meeting-notes/2026-11-12"}', { status: 200 });
    }) as typeof fetch;
    expect(await createMeetingNote('2026-11-12', { fetch: fake })).toEqual({
      docName: 'meeting-notes/2026-11-12',
      created: true,
    });
    expect(calls.map(([url]) => url)).toEqual([
      '/api/create-page',
      '/api/agent-write-md',
      '/api/frontmatter-patch',
    ]);
    expect(calls[2]?.[1]).toMatchObject({
      patch: { type: 'meeting', date: '2026-11-12' },
      clientName: BOARD_CLIENT_NAME,
    });
    const taken = (async () =>
      new Response('{"title":"File already exists."}', { status: 409 })) as typeof fetch;
    expect(await createMeetingNote('2026-11-12', { fetch: taken })).toEqual({
      docName: 'meeting-notes/2026-11-12',
      created: false,
    });
    const half = (async (url: string | URL | Request) =>
      String(url) === '/api/create-page'
        ? new Response('{"docName":"meeting-notes/2026-11-12"}', { status: 201 })
        : new Response('{}', { status: 500 })) as typeof fetch;
    await expect(createMeetingNote('2026-11-12', { fetch: half })).rejects.toBeInstanceOf(
      IncompleteNoteError,
    );
  });
});
