import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useId, useState } from 'react';
import { type Choice, ChoiceSelect } from '@/components/GitQuireChoice';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  type ActionFilter,
  actionItems,
  actionPeople,
  type BoardColumn,
  type BoardView,
  boardGroupKeys,
  buildBoard,
  type ColumnValue,
  filterActionItems,
  groupActionItems,
  UNASSIGNED,
} from '@/lib/gitquire/board';
import {
  NO_VALUE,
  type PageObject,
  summarizeChoices,
  summarizeFields,
} from '@/lib/gitquire/objects';
import { cn } from '@/lib/utils';

const DRAG_TYPE = 'application/x-gitquire-page';
const CARD_CLASS = 'flex flex-col gap-2 rounded-lg border bg-background p-2';
const COLUMN_CLASS = 'flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-muted/50 p-2';

function BoardCard({
  page,
  column,
  targets,
  busy,
  onOpen,
  onMove,
}: {
  page: PageObject;
  column: BoardColumn;
  targets: readonly Choice[];
  busy: boolean;
  onOpen: (docName: string) => void;
  onMove: (docName: string, value: string) => void;
}) {
  const { t } = useLingui();
  const title = page.title;
  return (
    <li
      className={cn(CARD_CLASS, busy && 'opacity-60')}
      draggable={!busy}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, page.docName);
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <Button
        type="button"
        variant="link"
        className="h-auto justify-start whitespace-normal p-0 text-start"
        onClick={() => onOpen(page.docName)}
      >
        {title}
      </Button>
      <ChoiceSelect
        label={t`Move "${title}" to`}
        value={column.value}
        choices={targets}
        disabled={busy}
        className="max-w-full"
        onChange={(value) => onMove(page.docName, value)}
      />
    </li>
  );
}

export function ObjectBoard({
  basis,
  pages,
  view,
  moving,
  onChange,
  onOpen,
  onMove,
}: {
  basis: PageObject[];
  pages: PageObject[];
  view: BoardView;
  moving: ReadonlySet<string>;
  onChange: (next: BoardView) => void;
  onOpen: (docName: string) => void;
  onMove: (docName: string, key: string, value: ColumnValue | null) => void;
}) {
  const { t } = useLingui();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const board = buildBoard(basis, view, pages);
  const noValueLabel = t`No value`;

  if (board === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {t`A board needs a property that several pages share, with a few different values, such as "status: To do" and "status: Done".`}
      </p>
    );
  }
  const groupKey = board.groupKey;
  const columns = board.columns;
  const known = new Set(summarizeFields(pages).map((field) => field.key));
  const filterKey = known.has(view.filterKey) ? view.filterKey : '';

  const groupKeys = boardGroupKeys(basis);
  const groupList = groupKeys.includes(groupKey) ? groupKeys : [groupKey, ...groupKeys];
  const groupChoices: Choice[] = groupList.map((key) => ({ value: key, label: key }));
  const propertyChoices: Choice[] = [
    { value: '', label: t`All pages with properties` },
    ...summarizeFields(pages).map((field) => ({ value: field.key, label: field.key })),
  ];
  const valueChoices: Choice[] = [
    { value: '', label: t`Any value` },
    { value: NO_VALUE, label: noValueLabel },
    ...summarizeChoices(pages, filterKey).map((choice) => ({
      value: choice.value,
      label: choice.value,
    })),
  ];
  const targets: Choice[] = columns.map((column) => ({
    value: column.value,
    label: column.value === '' ? noValueLabel : column.value,
  }));

  function moveTo(docName: string, value: string) {
    const from = columns.find((column) => column.pages.some((page) => page.docName === docName));
    const to = columns.find((column) => column.value === value);
    if (docName === '' || from === undefined || to === undefined || from === to) return;
    onMove(docName, groupKey, to.raw);
  }

  function drop(value: string, docName: string) {
    setDropTarget(null);
    moveTo(docName, value);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">{t`Columns from`}</span>
        <ChoiceSelect
          label={t`Columns from`}
          value={groupKey}
          choices={groupChoices}
          onChange={(next) => onChange({ ...view, groupKey: next })}
        />
        <ChoiceSelect
          label={t`Filter by property`}
          value={filterKey}
          choices={propertyChoices}
          onChange={(next) => onChange({ ...view, filterKey: next, filterValue: '' })}
        />
        {filterKey !== '' && (
          <ChoiceSelect
            label={t`Property value`}
            value={view.filterValue}
            choices={valueChoices}
            onChange={(next) => onChange({ ...view, filterValue: next })}
          />
        )}
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-auto pb-2">
        {columns.map((column) => (
          <section
            key={column.value}
            aria-label={column.value === '' ? noValueLabel : column.value}
            className={cn(COLUMN_CLASS, dropTarget === column.value && 'ring-2 ring-ring')}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              setDropTarget(column.value);
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(event) => {
              event.preventDefault();
              drop(column.value, event.dataTransfer.getData(DRAG_TYPE));
            }}
          >
            <h3 className="flex items-center gap-2 px-1 font-medium text-sm">
              <span className="truncate">{column.value === '' ? noValueLabel : column.value}</span>
              <span aria-hidden="true" className="text-muted-foreground text-xs">
                {column.pages.length}
              </span>
            </h3>
            <ul className="flex flex-col gap-2">
              {column.pages.map((page) => (
                <BoardCard
                  key={page.docName}
                  page={page}
                  column={column}
                  targets={targets}
                  busy={moving.has(page.docName)}
                  onOpen={onOpen}
                  onMove={moveTo}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export const EMPTY_ACTION_FILTER: ActionFilter = { person: '', showDone: false, search: '' };

export function ActionItemList({
  pages,
  me,
  filter,
  onFilter,
  onOpen,
}: {
  pages: PageObject[];
  me: string | null;
  filter: ActionFilter;
  onFilter: (next: ActionFilter) => void;
  onOpen: (docName: string) => void;
}) {
  const { t } = useLingui();
  const showDoneId = useId();
  const setFilter = onFilter;
  const items = actionItems(pages);
  const people = actionPeople(items);
  const groups = groupActionItems(filterActionItems(items, filter));
  const shown = groups.reduce((total, group) => total + group.items.length, 0);
  const mine = me?.toLowerCase() ?? '';
  const personChoices: Choice[] = [
    { value: '', label: t`Everyone` },
    ...(mine === '' ? [] : [{ value: mine, label: t`Mentioning me` }]),
    { value: UNASSIGNED, label: t`Nobody mentioned` },
    ...people
      .filter((person) => person.login !== mine)
      .map((person) => {
        const login = person.login;
        const open = person.open;
        return { value: login, label: t`@${login} (${open} open)` };
      }),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChoiceSelect
          label={t`Person`}
          value={filter.person}
          choices={personChoices}
          onChange={(person) => setFilter({ ...filter, person })}
        />
        <Input
          type="search"
          className="h-8 w-48"
          value={filter.search}
          placeholder={t`Search`}
          aria-label={t`Search`}
          onChange={(event) => setFilter({ ...filter, search: event.target.value })}
        />
        <span className="flex items-center gap-2">
          <Checkbox
            id={showDoneId}
            checked={filter.showDone}
            onCheckedChange={(checked) => setFilter({ ...filter, showDone: checked === true })}
          />
          <Label htmlFor={showDoneId} className="font-normal text-sm">
            {t`Show done`}
          </Label>
        </span>
        <span className="ms-auto text-muted-foreground text-xs">
          {plural(shown, { one: '# item', other: '# items' })}
        </span>
      </div>
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {items.length === 0
            ? t`No action items yet. Add a task list to any page ("- [ ] Call the printer") and it shows up here.`
            : t`Nothing matches.`}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {groups.map((group) => (
            <li key={group.docName} className="flex flex-col gap-1 rounded-lg border p-3">
              <Button
                type="button"
                variant="link"
                className="h-auto justify-start whitespace-normal p-0 text-start font-medium"
                onClick={() => onOpen(group.docName)}
              >
                {group.pageTitle}
              </Button>
              <ul className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <li key={item.id} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={item.done}
                      disabled
                      aria-label={item.done ? t`Done` : t`Open`}
                      className="mt-0.5"
                    />
                    <span className={cn(item.done && 'text-muted-foreground line-through')}>
                      {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
