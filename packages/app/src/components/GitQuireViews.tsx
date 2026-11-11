import { formatRelativeAge } from '@inkeep/open-knowledge-core/utils/relative-time';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { ArrowDown, ArrowUp, Columns3, LayoutList } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type Choice, ChoiceSelect } from '@/components/GitQuireChoice';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { hashFromDocName } from '@/lib/doc-hash';
import {
  EMPTY_TABLE_VIEW,
  fetchObjects,
  fieldOf,
  fieldText,
  filterPages,
  MODIFIED_COLUMN,
  NO_VALUE,
  normalizeTableView,
  type ObjectList,
  type PageObject,
  readTableView,
  sortPages,
  summarizeChoices,
  summarizeFields,
  type TableView,
  TITLE_COLUMN,
  tableColumns,
  writeTableView,
} from '@/lib/gitquire/objects';
import { revealEditor } from '@/lib/reveal-editor';

const TABLE_VIEW_STORAGE_KEY = 'gitquire.views.table';
const MAX_ROWS = 500;

function loadTableView(): TableView {
  try {
    return readTableView(window.localStorage.getItem(TABLE_VIEW_STORAGE_KEY));
  } catch {
    return EMPTY_TABLE_VIEW;
  }
}

function storeTableView(view: TableView): void {
  try {
    window.localStorage.setItem(TABLE_VIEW_STORAGE_KEY, writeTableView(view));
  } catch {}
}

const HEAD_CLASS = 'sticky top-0 z-10 bg-popover normal-case';
const MENU_CLASS = 'max-h-80 w-auto min-w-48 max-w-72 overflow-y-auto';

function SortButton({
  label,
  column,
  view,
  onSort,
}: {
  label: string;
  column: string;
  view: TableView;
  onSort: (column: string) => void;
}) {
  const active = view.sortKey === column;
  const Icon = view.descending ? ArrowDown : ArrowUp;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ms-2 h-7 gap-1 px-2 font-medium"
      onClick={() => onSort(column)}
    >
      {label}
      {active && <Icon aria-hidden="true" className="size-3" />}
    </Button>
  );
}

function sortState(view: TableView, column: string): 'ascending' | 'descending' | 'none' {
  if (view.sortKey !== column) return 'none';
  return view.descending ? 'descending' : 'ascending';
}

function ObjectTable({
  pages,
  saved,
  onChange,
  onOpen,
}: {
  pages: PageObject[];
  saved: TableView;
  onChange: (next: TableView) => void;
  onOpen: (docName: string) => void;
}) {
  const { t } = useLingui();
  const view = normalizeTableView(pages, saved);
  const fields = summarizeFields(pages);
  const columns = tableColumns(pages, view);
  const rows = sortPages(filterPages(pages, view), view);
  const shown = rows.slice(0, MAX_ROWS);
  const shownCount = shown.length;
  const rowCount = rows.length;

  if (fields.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t`No page has properties yet. Open a page, choose "Add properties" and give it for example a type and a status. It then shows up here.`}
      </p>
    );
  }

  const propertyChoices: Choice[] = [
    { value: '', label: t`All pages with properties` },
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

  function sortBy(column: string) {
    const descending = view.sortKey === column ? !view.descending : false;
    onChange({ ...view, sortKey: column, descending });
  }

  function toggleColumn(column: string, on: boolean) {
    const next = on ? [...columns, column] : columns.filter((key) => key !== column);
    onChange({ ...view, columns: next });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="ms-auto gap-1.5">
              <Columns3 aria-hidden="true" />
              {t`Columns`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={MENU_CLASS}>
            {fields.map((field) => (
              <DropdownMenuCheckboxItem
                key={field.key}
                checked={columns.includes(field.key)}
                onCheckedChange={(checked) => toggleColumn(field.key, checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="truncate">{field.key}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {rowCount === 0 ? (
        <p className="text-muted-foreground text-sm">{t`Nothing matches the filter.`}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
          <Table containerClassName="overflow-visible">
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD_CLASS} aria-sort={sortState(view, TITLE_COLUMN)}>
                  <SortButton label={t`Page`} column={TITLE_COLUMN} view={view} onSort={sortBy} />
                </TableHead>
                {columns.map((column) => (
                  <TableHead
                    key={column}
                    className={HEAD_CLASS}
                    aria-sort={sortState(view, column)}
                  >
                    <SortButton label={column} column={column} view={view} onSort={sortBy} />
                  </TableHead>
                ))}
                <TableHead className={HEAD_CLASS} aria-sort={sortState(view, MODIFIED_COLUMN)}>
                  <SortButton
                    label={t`Changed`}
                    column={MODIFIED_COLUMN}
                    view={view}
                    onSort={sortBy}
                  />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((page) => (
                <TableRow key={page.docName}>
                  <TableCell>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto max-w-72 justify-start whitespace-normal p-0 text-start"
                      onClick={() => onOpen(page.docName)}
                    >
                      {page.title}
                    </Button>
                  </TableCell>
                  {columns.map((column) => {
                    const text = fieldText(fieldOf(page, column));
                    return (
                      <TableCell key={column} className="max-w-64 truncate" title={text}>
                        {text}
                      </TableCell>
                    );
                  })}
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatRelativeAge(page.modified)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        {rowCount > shownCount
          ? t`Showing the first ${shownCount} of ${rowCount} pages. Filter to narrow the list.`
          : plural(rowCount, { one: '# page', other: '# pages' })}
      </p>
    </div>
  );
}

export function GitQuireViews() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ObjectList | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<TableView>(loadTableView);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchObjects().then(
      (next) => {
        if (!live) return;
        setList(next);
        setFailed(false);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [open, attempt]);

  const loading = list === null && !failed;

  function changeOpen(next: boolean) {
    if (next) setFailed(false);
    setOpen(next);
  }

  function changeView(next: TableView) {
    setView(next);
    storeTableView(next);
  }

  function openPage(docName: string) {
    setOpen(false);
    revealEditor();
    window.location.assign(hashFromDocName(docName));
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="hidden sm:inline-flex"
        aria-label={t`Views`}
        onClick={() => changeOpen(true)}
        data-testid="views-toggle"
      >
        <LayoutList aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="h-[calc(100dvh-2rem)] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t`Views`}</DialogTitle>
            <DialogDescription>
              {t`Pages with properties, as a table. Add properties to a page to list it here.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex min-h-0 flex-1 flex-col gap-3">
            {failed && (
              <p className="flex items-center gap-2 text-destructive text-sm">
                {t`Couldn't load the pages.`}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFailed(false);
                    setAttempt(attempt + 1);
                  }}
                >
                  {t`Try again`}
                </Button>
              </p>
            )}
            {loading && <p className="text-muted-foreground text-sm">{t`Loading…`}</p>}
            {list?.truncated === true && (
              <p className="text-muted-foreground text-xs">
                {t`This wiki has more pages than a view can show; the list is cut off.`}
              </p>
            )}
            {list !== null && (
              <ObjectTable
                pages={list.pages}
                saved={view}
                onChange={changeView}
                onOpen={openPage}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
