import { BOARD_CLIENT_NAME } from './board';
import { type ApiDeps, GitQuireApiError, gitquireRequest } from './branch-api';
import {
  type FieldValue,
  fieldChoices,
  fieldOf,
  fieldText,
  matchesFilter,
  type PageObject,
} from './objects';

const DAY_RE = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/;
const PREFERRED_DATE_KEYS = ['date', 'day', 'meeting_date', 'when', 'held'];
const ATTENDEE_KEYS = ['attendees', 'participants', 'people', 'who'];
const MEETING_FOLDER = 'meeting-notes';

export interface TimelineView {
  dateKey: string;
  filterKey: string;
  filterValue: string;
  search: string;
}

export const EMPTY_TIMELINE_VIEW: TimelineView = {
  dateKey: '',
  filterKey: '',
  filterValue: '',
  search: '',
};

export function readTimelineView(raw: string | null): TimelineView {
  if (raw === null) return EMPTY_TIMELINE_VIEW;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof TimelineView, unknown>> | null;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    return {
      dateKey: text(parsed?.dateKey),
      filterKey: text(parsed?.filterKey),
      filterValue: text(parsed?.filterValue),
      search: text(parsed?.search),
    };
  } catch {
    return EMPTY_TIMELINE_VIEW;
  }
}

function validDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(day);
}

export function dayOf(value: FieldValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const day = DAY_RE.exec(value.trim())?.[1];
  return day !== undefined && validDay(day) ? day : undefined;
}

export function dateKeys(pages: readonly PageObject[]): string[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const [key, value] of Object.entries(page.fields)) {
      if (dayOf(value) !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const rank = (key: string) => {
    const preferred = PREFERRED_DATE_KEYS.indexOf(key.toLowerCase());
    return preferred === -1 ? PREFERRED_DATE_KEYS.length : preferred;
  };
  return [...counts]
    .sort(([a, countA], [b, countB]) => rank(a) - rank(b) || countB - countA || a.localeCompare(b))
    .map(([key]) => key);
}

export function timelineDateKey(pages: readonly PageObject[], view: TimelineView): string {
  const keys = dateKeys(pages);
  return keys.includes(view.dateKey) ? view.dateKey : (keys[0] ?? '');
}

export function attendeesOf(page: PageObject): string[] {
  for (const key of ATTENDEE_KEYS) {
    const value = fieldOf(page, key);
    if (value === undefined || value === null) continue;
    const names = Array.isArray(value)
      ? fieldChoices(value)
      : fieldText(value)
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
    if (names.length > 0) return names;
  }
  return [];
}

export interface TimelineEntry {
  page: PageObject;
  day: string;
  open: number;
  done: number;
}

interface TimelineMonth {
  month: string;
  entries: TimelineEntry[];
}

export function buildTimeline(pages: readonly PageObject[], view: TimelineView): TimelineMonth[] {
  const dateKey = timelineDateKey(pages, view);
  if (dateKey === '') return [];
  const wanted = view.search.trim().toLowerCase();
  const entries: TimelineEntry[] = [];
  for (const page of pages) {
    const day = dayOf(fieldOf(page, dateKey));
    if (day === undefined || !matchesFilter(page, view.filterKey, view.filterValue)) continue;
    if (wanted !== '') {
      const haystack = [page.title, page.docName, ...(page.decisions ?? []), ...attendeesOf(page)]
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(wanted)) continue;
    }
    const open = page.tasks.filter((task) => !task.done).length;
    entries.push({ page, day, open, done: page.tasks.length - open });
  }
  entries.sort(
    (a, b) =>
      (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) ||
      a.page.title.localeCompare(b.page.title, undefined, { numeric: true }),
  );
  const months: TimelineMonth[] = [];
  for (const entry of entries) {
    const month = entry.day.slice(0, 7);
    const last = months.at(-1);
    if (last?.month === month) last.entries.push(entry);
    else months.push({ month, entries: [entry] });
  }
  return months;
}

function meetingNoteDocName(day: string): string {
  return `${MEETING_FOLDER}/${day}`;
}

function meetingNoteBody(day: string): string {
  return [`# Meeting ${day}`, '', '## Agenda', '', '## Decisions', '', '## Action items', ''].join(
    '\n',
  );
}

interface CreatedNote {
  docName: string;
  created: boolean;
}

export class IncompleteNoteError extends Error {
  readonly docName: string;
  constructor(docName: string) {
    super('The meeting note was created but could not be filled in.');
    this.name = 'IncompleteNoteError';
    this.docName = docName;
  }
}

function markAsMeeting(docName: string, day: string, deps: ApiDeps): Promise<unknown> {
  return gitquireRequest(
    '/api/frontmatter-patch',
    {
      method: 'POST',
      body: {
        docName,
        patch: { type: 'meeting', date: day },
        summary: `New meeting note ${day}`,
        clientName: BOARD_CLIENT_NAME,
      },
    },
    deps,
  );
}

export async function createMeetingNote(day: string, deps: ApiDeps = {}): Promise<CreatedNote> {
  const wanted = meetingNoteDocName(day);
  let docName = wanted;
  try {
    const body = { path: `${wanted}.md` };
    const created = await gitquireRequest<{ docName?: unknown } | undefined>(
      '/api/create-page',
      { method: 'POST', body },
      deps,
    );
    if (typeof created?.docName === 'string' && created.docName !== '') docName = created.docName;
  } catch (err) {
    if (!(err instanceof GitQuireApiError) || err.status !== 409) throw err;
    await markAsMeeting(wanted, day, deps).catch(() => undefined);
    return { docName: wanted, created: false };
  }
  try {
    await gitquireRequest(
      '/api/agent-write-md',
      {
        method: 'POST',
        body: {
          docName,
          markdown: meetingNoteBody(day),
          position: 'replace',
          summary: `New meeting note ${day}`,
          clientName: BOARD_CLIENT_NAME,
        },
      },
      deps,
    );
    await markAsMeeting(docName, day, deps);
  } catch {
    throw new IncompleteNoteError(docName);
  }
  return { docName, created: true };
}
