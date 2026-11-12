import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatDay } from '@/components/GitQuireBoard';
import { type Choice, ChoiceSelect } from '@/components/GitQuireChoice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { localDay } from '@/lib/gitquire/board';
import {
  NO_VALUE,
  type PageObject,
  summarizeChoices,
  summarizeFields,
} from '@/lib/gitquire/objects';
import {
  attendeesOf,
  buildTimeline,
  createMeetingNote,
  dateKeys,
  IncompleteNoteError,
  type TimelineEntry,
  type TimelineView,
  timelineDateKey,
} from '@/lib/gitquire/timeline';
import { cn } from '@/lib/utils';

const MAX_DECISIONS_SHOWN = 3;
const MAX_ATTENDEES_SHOWN = 6;

function monthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function TimelineCard({
  entry,
  today,
  onOpen,
}: {
  entry: TimelineEntry;
  today: string;
  onOpen: (docName: string) => void;
}) {
  const { t } = useLingui();
  const { page, day, open, done } = entry;
  const attendees = attendeesOf(page);
  const shownAttendees = attendees.slice(0, MAX_ATTENDEES_SHOWN);
  const moreAttendees = attendees.length - shownAttendees.length;
  const decisions = page.decisions ?? [];
  const seen = new Map<string, number>();
  const shownDecisions = decisions.slice(0, MAX_DECISIONS_SHOWN).map((text) => {
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return { key: `${count}:${text}`, text };
  });
  const moreDecisions = decisions.length - shownDecisions.length;
  const upcoming = day >= today;
  return (
    <li className="relative">
      <span
        aria-hidden="true"
        className={cn(
          '-start-[1.6875rem] absolute top-4 size-3 rounded-full border-2 border-background',
          upcoming ? 'bg-primary' : 'bg-muted-foreground/50',
        )}
      />
      <article className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <time dateTime={day} className="font-medium text-muted-foreground text-xs">
            {formatDay(day)}
          </time>
          <Button
            type="button"
            variant="link"
            className="h-auto justify-start whitespace-normal p-0 text-start font-semibold"
            onClick={() => onOpen(page.docName)}
          >
            {page.title}
          </Button>
          {shownAttendees.length > 0 && (
            <span className="ms-auto text-muted-foreground text-xs">
              {shownAttendees.join(', ')}
              {moreAttendees > 0 && ` ${t`and ${moreAttendees} more`}`}
            </span>
          )}
        </div>
        {shownDecisions.length > 0 && (
          <ul className="flex list-disc flex-col gap-0.5 ps-5 text-sm">
            {shownDecisions.map((decision) => (
              <li key={decision.key}>{decision.text}</li>
            ))}
            {moreDecisions > 0 && (
              <li className="list-none text-muted-foreground text-xs">
                {plural(moreDecisions, { one: '# more decision', other: '# more decisions' })}
              </li>
            )}
          </ul>
        )}
        {open + done > 0 && (
          <p
            className={cn(
              'self-start rounded-full border px-2 py-0.5 text-xs',
              open > 0 ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {open > 0
              ? plural(open, { one: '# open action item', other: '# open action items' })
              : t`All action items done`}
          </p>
        )}
      </article>
    </li>
  );
}

export function TimelineList({
  pages,
  view,
  onChange,
  onOpen,
}: {
  pages: PageObject[];
  view: TimelineView;
  onChange: (next: TimelineView) => void;
  onOpen: (docName: string) => void;
}) {
  const { t } = useLingui();
  const [creating, setCreating] = useState(false);
  const today = localDay(new Date());
  const keys = dateKeys(pages);
  const dateKey = timelineDateKey(pages, view);
  const months = buildTimeline(pages, view);
  const count = months.reduce((total, month) => total + month.entries.length, 0);
  const fields = summarizeFields(pages);

  const dateChoices: Choice[] = keys.map((key) => ({ value: key, label: key }));
  const propertyChoices: Choice[] = [
    { value: '', label: t`All dated pages` },
    ...fields.map((field) => ({ value: field.key, label: field.key })),
  ];
  const valueChoices: Choice[] = [
    { value: '', label: t`Any value` },
    { value: NO_VALUE, label: t`No value` },
    ...summarizeChoices(pages, view.filterKey).map((choice) => ({
      value: choice.value,
      label: choice.value,
    })),
  ];

  function newMeetingNote() {
    if (creating) return;
    setCreating(true);
    createMeetingNote(today).then(
      (note) => {
        setCreating(false);
        if (!note.created) toast(t`Today's meeting note already exists. It was opened.`);
        onOpen(note.docName);
      },
      (err: unknown) => {
        setCreating(false);
        if (err instanceof IncompleteNoteError) {
          toast.error(
            t`The meeting note was created, but its date and headings couldn't be added.`,
          );
          onOpen(err.docName);
          return;
        }
        toast.error(t`Couldn't create the meeting note.`);
      },
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {keys.length > 1 && (
          <ChoiceSelect
            label={t`Date from`}
            value={dateKey}
            choices={dateChoices}
            onChange={(next) => onChange({ ...view, dateKey: next })}
          />
        )}
        <ChoiceSelect
          label={t`Filter by property`}
          value={view.filterKey}
          choices={propertyChoices}
          onChange={(filterKey) => onChange({ ...view, filterKey, filterValue: '' })}
        />
        {view.filterKey !== '' && (
          <ChoiceSelect
            label={t`Property value`}
            value={view.filterValue}
            choices={valueChoices}
            onChange={(filterValue) => onChange({ ...view, filterValue })}
          />
        )}
        <Input
          type="search"
          className="h-8 w-48"
          value={view.search}
          placeholder={t`Search`}
          aria-label={t`Search`}
          onChange={(event) => onChange({ ...view, search: event.target.value })}
        />
        <Button
          type="button"
          size="sm"
          className="ms-auto gap-1.5"
          disabled={creating}
          onClick={newMeetingNote}
        >
          <Plus aria-hidden="true" />
          {t`New meeting note`}
        </Button>
      </div>
      {dateKey === '' ? (
        <p className="text-muted-foreground text-sm">
          {t`No page has a date yet. Give a page a date property ("date: 2026-11-12"), or choose "New meeting note".`}
        </p>
      ) : months.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t`Nothing matches the filter.`}</p>
      ) : (
        <ol className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pe-1">
          {months.map((month) => (
            <li key={month.month} className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <h3 className="font-medium text-muted-foreground text-sm">
                {monthLabel(month.month)}
              </h3>
              <ol className="ms-2 flex flex-col gap-3 border-s-2 ps-5">
                {month.entries.map((entry) => (
                  <TimelineCard
                    key={entry.page.docName}
                    entry={entry}
                    today={today}
                    onOpen={onOpen}
                  />
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
      <p className="text-muted-foreground text-xs">
        {plural(count, { one: '# dated page', other: '# dated pages' })}
      </p>
    </div>
  );
}
