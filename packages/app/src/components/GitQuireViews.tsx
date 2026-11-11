import { formatRelativeAge } from '@inkeep/open-knowledge-core/utils/relative-time';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { ArrowDown, ArrowUp, Columns3, LayoutList } from 'lucide-react';
import { useEffect, useState } from 'react';
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
  fieldText,
  filterPages,
  MODIFIED_COLUMN,
  type ObjectList,
  type PageObject,
  readTableView,
  sortPages,
  summarizeChoices,
  summarizeFields,
  type TableView,
  TITLE_COLUMN,
  tableColumns,
} from '@/lib/gitquire/objects';
import { revealEditor } from '@/lib/reveal-editor';

const TABLE_VIEW_STORAGE_KEY = 'gitquire.views.table';
const SELECT_CLASS =
  'h-8 max-w-48 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
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
    window.localStorage.setItem(TABLE_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {}
}

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
  view,
  onChange,
  onOpen,
}: {
  pages: PageObject[];
  view: TableView;
  onChange: (next: TableView) => void;
  onOpen: (docName: string) => void;
}) {
  const { t } = useLingui();
  const fields = summarizeFields(pages);
  const columns = tableColumns(pages, view);
  const choices = view.filterKey === '' ? [] : summarizeChoices(pages, view.filterKey);
  const rows = sortPages(filterPages(pages, view), view);
  const shown = rows.slice(0, MAX_ROWS);

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
        <select
          className={SELECT_CLASS}
          aria-label={t`Filter by field`}
          value={view.filterKey}
          onChange={(event) =>
            onChange({ ...view, filterKey: event.target.value, filterValue: '' })
          }
        >
          <option value="">{t`All pages with fields`}</option>
          {fields.map((field) => (
            <option key={field.key} value={field.key}>
              {field.key}
            </option>
          ))}
        </select>
        {view.filterKey !== '' && (
          <select
            className={SELECT_CLASS}
            aria-label={t`Field value`}
            value={view.filterValue}
            onChange={(event) => onChange({ ...view, filterValue: event.target.value })}
          >
            <option value="">{t`No value`}</option>
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.value} ({choice.pages})
              </option>
            ))}
          </select>
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
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            {fields.map((field) => (
              <DropdownMenuCheckboxItem
                key={field.key}
                checked={columns.includes(field.key)}
                onCheckedChange={(checked) => toggleColumn(field.key, checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                {field.key}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={sortState(view, TITLE_COLUMN)}>
                <SortButton label={t`Page`} column={TITLE_COLUMN} view={view} onSort={sortBy} />
              </TableHead>
              {columns.map((column) => (
                <TableHead key={column} aria-sort={sortState(view, column)}>
                  <SortButton label={column} column={column} view={view} onSort={sortBy} />
                </TableHead>
              ))}
              <TableHead aria-sort={sortState(view, MODIFIED_COLUMN)}>
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
                {columns.map((column) => (
                  <TableCell key={column} className="max-w-64 truncate">
                    {fieldText(page.fields[column])}
                  </TableCell>
                ))}
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatRelativeAge(page.modified)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground text-xs">
        {rows.length > shown.length
          ? t`Showing the first ${shown.length} of ${rows.length} pages. Filter to narrow the list.`
          : plural(rows.length, { one: '# page', other: '# pages' })}
      </p>
    </div>
  );
}

export function GitQuireViews() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ObjectList | null>(null);
  const [failed, setFailed] = useState(false);
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
  }, [open]);

  const loading = list === null && !failed;

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
        aria-label={t`Views`}
        onClick={() => setOpen(true)}
        data-testid="views-toggle"
      >
        <LayoutList aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="h-[calc(100dvh-2rem)] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t`Views`}</DialogTitle>
            <DialogDescription>
              {t`Pages with properties, as a table. Add properties to a page to list it here.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex min-h-0 flex-1 flex-col gap-3">
            {failed && <p className="text-destructive text-sm">{t`Couldn't load the pages.`}</p>}
            {loading && <p className="text-muted-foreground text-sm">{t`Loading…`}</p>}
            {list?.truncated === true && (
              <p className="text-muted-foreground text-xs">
                {t`This wiki has more pages than a view can show; the list is cut off.`}
              </p>
            )}
            {list !== null && (
              <ObjectTable pages={list.pages} view={view} onChange={changeView} onOpen={openPage} />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
