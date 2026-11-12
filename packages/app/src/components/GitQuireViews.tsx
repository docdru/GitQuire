import { formatRelativeAge } from '@inkeep/open-knowledge-core/utils/relative-time';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { ArrowDown, ArrowUp, Columns3, LayoutList, Save } from 'lucide-react';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ActionItemList, EMPTY_ACTION_FILTER, ObjectBoard } from '@/components/GitQuireBoard';
import { type Choice, ChoiceSelect } from '@/components/GitQuireChoice';
import { TimelineList } from '@/components/GitQuireTimeline';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { currentAuthor } from '@/gitquire-comments/ui-store';
import { hashFromDocName } from '@/lib/doc-hash';
import {
  type ActionFilter,
  type ActionItem,
  applyPendingMoves,
  type BoardView,
  type ColumnValue,
  EMPTY_BOARD_VIEW,
  localDay,
  markTask,
  movePage,
  type PendingMove,
  readBoardView,
  StaleTaskError,
  setPageField,
  setTaskDone,
} from '@/lib/gitquire/board';
import { GitQuireApiError } from '@/lib/gitquire/branch-api';
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
import { readTimelineView, type TimelineView } from '@/lib/gitquire/timeline';
import {
  PageExistsError,
  savedViewDocName,
  saveViewAsPage,
  specFromActions,
  specFromBoard,
  specFromTable,
  specFromTimeline,
  type ViewSpec,
  writeViewBlock,
} from '@/lib/gitquire/view-block';
import { revealEditor } from '@/lib/reveal-editor';

const TABLE_VIEW_STORAGE_KEY = 'gitquire.views.table';
const BOARD_VIEW_STORAGE_KEY = 'gitquire.views.board';
const TIMELINE_VIEW_STORAGE_KEY = 'gitquire.views.timeline';
const TAB_CLASS = 'flex min-h-0 flex-1 flex-col';
const MAX_ROWS = 500;
const UNDO_MS = 10_000;

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

function loadBoardView(): BoardView {
  try {
    return readBoardView(window.localStorage.getItem(BOARD_VIEW_STORAGE_KEY));
  } catch {
    return EMPTY_BOARD_VIEW;
  }
}

function storeBoardView(view: BoardView): void {
  try {
    window.localStorage.setItem(BOARD_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {}
}

function loadTimelineView(): TimelineView {
  try {
    return readTimelineView(window.localStorage.getItem(TIMELINE_VIEW_STORAGE_KEY));
  } catch {
    return readTimelineView(null);
  }
}

function storeTimelineView(view: TimelineView): void {
  try {
    const kept = { ...view, search: '' };
    window.localStorage.setItem(TIMELINE_VIEW_STORAGE_KEY, JSON.stringify(kept));
  } catch {}
}

const HEAD_CLASS = 'sticky top-0 z-10 bg-popover normal-case';
const MENU_CLASS = 'max-h-80 w-auto min-w-48 max-w-72 overflow-y-auto';

function loadObjects(
  onList: (list: ObjectList) => void,
  onFailed: (failed: boolean) => void,
): () => void {
  let live = true;
  onFailed(false);
  fetchObjects().then(
    (next) => {
      if (live) onList(next);
    },
    () => {
      if (live) onFailed(true);
    },
  );
  return () => {
    live = false;
  };
}

interface ToggleContext {
  saving: { current: Set<string> };
  setSaving: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setList: Dispatch<SetStateAction<ObjectList | null>>;
  reload: () => void;
  labels: {
    done: (text: string) => string;
    reopened: (text: string) => string;
    undo: string;
    stale: string;
    failed: string;
  };
}

function setItemSaving(context: ToggleContext, id: string, on: boolean): void {
  if (on) context.saving.current.add(id);
  else context.saving.current.delete(id);
  context.setSaving(new Set(context.saving.current));
}

function startToggle(item: ActionItem, done: boolean, undo: boolean, context: ToggleContext): void {
  if (context.saving.current.has(item.id)) return;
  setItemSaving(context, item.id, true);
  const mark = (source: string) =>
    context.setList((current) => {
      if (current === null) return current;
      return { ...current, pages: markTask(current.pages, item, done, source) };
    });
  mark(item.source ?? '');
  setTaskDone(item, done).then(
    (source) => {
      setItemSaving(context, item.id, false);
      mark(source);
      if (undo) return;
      const changed = { ...item, done, source };
      const { labels } = context;
      toast(done ? labels.done(item.text) : labels.reopened(item.text), {
        duration: UNDO_MS,
        action: { label: labels.undo, onClick: () => startToggle(changed, !done, true, context) },
      });
    },
    (err: unknown) => {
      setItemSaving(context, item.id, false);
      toast.error(err instanceof StaleTaskError ? context.labels.stale : context.labels.failed);
      context.reload();
    },
  );
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

function SaveViewDialog({
  spec,
  open,
  onOpenChange,
  onSaved,
}: {
  spec: ViewSpec;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (docName: string) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docName = savedViewDocName(name);

  function save() {
    if (docName === undefined || saving) return;
    setSaving(true);
    setError(null);
    saveViewAsPage(name, spec).then(
      (created) => {
        setSaving(false);
        setName('');
        onSaved(created);
      },
      (err: unknown) => {
        setSaving(false);
        setError(
          err instanceof PageExistsError
            ? t`A page with that name exists. Choose another name.`
            : t`Couldn't save the view.`,
        );
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t`Save view as page`}</DialogTitle>
          <DialogDescription>
            {t`The page shows this view live, for everyone, and is committed like any page.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Input
            value={name}
            placeholder={t`Open tasks`}
            aria-label={t`Page name`}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
          />
          <p className="text-muted-foreground text-xs">
            {docName === undefined ? t`Enter a name.` : t`Saved as ${docName}.md`}
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
            {writeViewBlock(spec)}
          </pre>
          {error !== null && <p className="text-destructive text-sm">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t`Cancel`}
          </Button>
          <Button type="button" disabled={docName === undefined || saving} onClick={save}>
            {t`Save page`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GitQuireViews() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ObjectList | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<TableView>(loadTableView);
  const [boardView, setBoardView] = useState<BoardView>(loadBoardView);
  const [timelineView, setTimelineView] = useState<TimelineView>(loadTimelineView);
  const [tab, setTab] = useState('table');
  const [pending, setPending] = useState<ReadonlyMap<string, PendingMove>>(() => new Map());
  const [actionFilter, setActionFilter] = useState<ActionFilter>(EMPTY_ACTION_FILTER);
  const [me, setMe] = useState<string | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const savingRef = useRef(new Set<string>());
  const [savingView, setSavingView] = useState(false);
  const today = localDay(new Date());

  useEffect(() => {
    if (!open) return;
    return loadObjects(setList, setFailed);
  }, [open]);

  const loading = list === null && !failed;
  const shownPages = list === null ? [] : applyPendingMoves(list.pages, pending);
  const movingPages = new Set(pending.keys());

  function changeOpen(next: boolean) {
    if (next) setFailed(false);
    setOpen(next);
  }

  useEffect(() => {
    if (!open || me !== null) return;
    let live = true;
    currentAuthor().then(
      (author) => {
        if (live && author.login !== undefined) setMe(author.login);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, me]);

  function changeView(next: TableView) {
    setView(next);
    storeTableView(next);
  }

  function changeTimelineView(next: TimelineView) {
    setTimelineView(next);
    storeTimelineView(next);
  }

  function changeBoardView(next: BoardView) {
    setBoardView(next);
    storeBoardView(next);
  }

  function settle(docName: string): void {
    setPending((current) => {
      const next = new Map(current);
      next.delete(docName);
      return next;
    });
  }

  function move(docName: string, key: string, value: ColumnValue | null) {
    if (pending.has(docName)) return;
    setPending((current) => new Map(current).set(docName, { key, value }));
    const saved = () => {
      setList((current) => {
        if (current === null) return current;
        return { ...current, pages: movePage(current.pages, docName, key, value) };
      });
      settle(docName);
    };
    setPageField(docName, key, value).then(saved, (err: unknown) => {
      if (err instanceof GitQuireApiError && err.status === 409) {
        saved();
        return;
      }
      settle(docName);
      toast.error(t`Couldn't move the page. The board was reloaded.`);
      loadObjects(setList, setFailed);
    });
  }

  const toggleContext: ToggleContext = {
    saving: savingRef,
    setSaving,
    setList,
    reload: () => loadObjects(setList, setFailed),
    labels: {
      done: (text) => t`Marked done: ${text}`,
      reopened: (text) => t`Reopened: ${text}`,
      undo: t`Undo`,
      stale: t`That action item changed on its page. The list was reloaded.`,
      failed: t`Couldn't save the action item. The list was reloaded.`,
    },
  };

  function toggleTask(item: ActionItem, done: boolean): void {
    startToggle(item, done, false, toggleContext);
  }

  function currentSpec(): ViewSpec {
    if (tab === 'board') return specFromBoard(boardView);
    if (tab === 'timeline') return specFromTimeline(timelineView);
    if (tab === 'actions') return specFromActions(actionFilter);
    return specFromTable(view);
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
              {t`Pages with properties as a table, a board or a timeline, and the action items of all pages.`}
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
                    loadObjects(setList, setFailed);
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
              <Tabs
                value={tab}
                onValueChange={setTab}
                className="flex min-h-0 flex-1 flex-col gap-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <TabsList>
                    <TabsTrigger value="table">{t`Table`}</TabsTrigger>
                    <TabsTrigger value="board">{t`Board`}</TabsTrigger>
                    <TabsTrigger value="timeline">{t`Timeline`}</TabsTrigger>
                    <TabsTrigger value="actions">{t`Action items`}</TabsTrigger>
                  </TabsList>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ms-auto gap-1.5"
                    onClick={() => setSavingView(true)}
                  >
                    <Save aria-hidden="true" />
                    {t`Save as page`}
                  </Button>
                </div>
                <TabsContent value="table" className={TAB_CLASS}>
                  <ObjectTable
                    pages={shownPages}
                    saved={view}
                    onChange={changeView}
                    onOpen={openPage}
                  />
                </TabsContent>
                <TabsContent value="board" className={TAB_CLASS}>
                  <ObjectBoard
                    basis={list.pages}
                    pages={shownPages}
                    view={boardView}
                    moving={movingPages}
                    onChange={changeBoardView}
                    onOpen={openPage}
                    onMove={move}
                  />
                </TabsContent>
                <TabsContent value="timeline" className={TAB_CLASS}>
                  <TimelineList
                    pages={shownPages}
                    view={timelineView}
                    onChange={changeTimelineView}
                    onOpen={openPage}
                  />
                </TabsContent>
                <TabsContent value="actions" className={TAB_CLASS}>
                  <ActionItemList
                    pages={shownPages}
                    me={me}
                    filter={actionFilter}
                    today={today}
                    saving={saving}
                    onFilter={setActionFilter}
                    onToggle={toggleTask}
                    onOpen={openPage}
                  />
                </TabsContent>
              </Tabs>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
      <SaveViewDialog
        spec={currentSpec()}
        open={savingView}
        onOpenChange={setSavingView}
        onSaved={(docName) => {
          setSavingView(false);
          openPage(docName);
        }}
      />
    </>
  );
}
