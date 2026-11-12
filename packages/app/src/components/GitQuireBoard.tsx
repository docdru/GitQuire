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
  type ActionGroup,
  type ActionGrouping,
  type ActionItem,
  actionItems,
  actionPeople,
  type BoardColumn,
  type BoardView,
  boardGroupKeys,
  buildBoard,
  type ColumnValue,
  dueBucket,
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

export const EMPTY_ACTION_FILTER: ActionFilter = {
  person: '',
  showDone: false,
  search: '',
  grouping: 'page',
};

function DueLabel({ item, today }: { item: ActionItem; today: string }) {
  const { t } = useLingui();
  if (item.due === undefined) return null;
  const overdue = !item.done && item.due < today;
  const label = formatDay(item.due);
  return (
    <span
      className={cn(
        'shrink-0 whitespace-nowrap text-xs',
        overdue ? 'font-medium text-destructive' : 'text-muted-foreground',
      )}
    >
      {overdue ? t`Due ${label}, overdue` : t`Due ${label}`}
    </span>
  );
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function ActionRow({
  item,
  today,
  showPage,
  saving,
  onToggle,
  onOpen,
}: {
  item: ActionItem;
  today: string;
  showPage: boolean;
  saving: boolean;
  onToggle: (item: ActionItem, done: boolean) => void;
  onOpen: (docName: string) => void;
}) {
  const { t } = useLingui();
  const checkboxId = useId();
  const text = item.text;
  const canToggle = item.source !== undefined;
  return (
    <li className="flex flex-wrap items-start gap-x-2 gap-y-1 text-sm">
      <Checkbox
        id={checkboxId}
        checked={item.done}
        disabled={saving || !canToggle}
        aria-label={item.done ? t`Reopen: ${text}` : t`Mark done: ${text}`}
        onCheckedChange={(checked) => onToggle(item, checked === true)}
        className="mt-0.5"
      />
      <Label
        htmlFor={checkboxId}
        className={cn(
          'min-w-0 flex-1 font-normal leading-normal',
          item.done && 'text-muted-foreground line-through',
        )}
      >
        {text}
      </Label>
      <DueLabel item={item} today={today} />
      {showPage && (
        <Button
          type="button"
          variant="link"
          className="h-auto max-w-56 shrink-0 justify-start truncate p-0 text-xs"
          onClick={() => onOpen(item.docName)}
        >
          {item.pageTitle}
        </Button>
      )}
    </li>
  );
}

function GroupHeading({
  group,
  onOpen,
}: {
  group: ActionGroup;
  onOpen: (docName: string) => void;
}) {
  const { t } = useLingui();
  const docName = group.docName;
  if (docName !== undefined) {
    return (
      <Button
        type="button"
        variant="link"
        className="h-auto justify-start whitespace-normal p-0 text-start font-medium"
        onClick={() => onOpen(docName)}
      >
        {group.pageTitle}
      </Button>
    );
  }
  const titles: Record<string, string> = {
    overdue: t`Overdue`,
    today: t`Today`,
    week: t`Next 7 days`,
    later: t`Later`,
    earlier: t`Done, due earlier`,
    none: t`No due date`,
  };
  const login = group.login;
  const title =
    group.due !== undefined
      ? titles[group.due]
      : login === undefined
        ? t`Nobody mentioned`
        : `@${login}`;
  return (
    <h3 className={cn('font-medium text-sm', group.due === 'overdue' && 'text-destructive')}>
      {title}
    </h3>
  );
}

export function ActionItemList({
  pages,
  me,
  filter,
  today,
  saving,
  onFilter,
  onToggle,
  onOpen,
}: {
  pages: PageObject[];
  me: string | null;
  filter: ActionFilter;
  today: string;
  saving: ReadonlySet<string>;
  onFilter: (next: ActionFilter) => void;
  onToggle: (item: ActionItem, done: boolean) => void;
  onOpen: (docName: string) => void;
}) {
  const { t } = useLingui();
  const showDoneId = useId();
  const setFilter = onFilter;
  const grouping = filter.grouping ?? 'page';
  const items = actionItems(pages);
  const people = actionPeople(items);
  const matching = filterActionItems(items, filter);
  const groups = groupActionItems(matching, grouping, today);
  const shown = matching.length;
  const overdue = matching.filter((item) => dueBucket(item, today) === 'overdue').length;
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
  const groupingChoices: Choice[] = [
    { value: 'page', label: t`Group by page` },
    { value: 'due', label: t`Group by due date` },
    { value: 'person', label: t`Group by person` },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChoiceSelect
          label={t`Group action items`}
          value={grouping}
          choices={groupingChoices}
          onChange={(value) => setFilter({ ...filter, grouping: value as ActionGrouping })}
        />
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
          {overdue > 0 && ` · ${plural(overdue, { one: '# overdue', other: '# overdue' })}`}
        </span>
      </div>
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {items.length === 0
            ? t`No action items yet. Add a task list to any page ("- [ ] Call the printer due: 2026-12-01") and it shows up here.`
            : t`Nothing matches.`}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {groups.map((group) => (
            <li key={group.key} className="flex flex-col gap-1 rounded-lg border p-3">
              <GroupHeading group={group} onOpen={onOpen} />
              <ul className="flex flex-col gap-1.5">
                {group.items.map((item) => (
                  <ActionRow
                    key={`${group.key}:${item.id}`}
                    item={item}
                    today={today}
                    showPage={group.docName === undefined}
                    saving={saving.has(item.id)}
                    onToggle={onToggle}
                    onOpen={onOpen}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
