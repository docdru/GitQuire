import { formatRelativeAge } from '@inkeep/open-knowledge-core/utils/relative-time';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { LayoutList, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { hashFromDocName } from '@/lib/doc-hash';
import {
  type ActionItem,
  actionItems,
  buildBoard,
  dueBucket,
  filterActionItems,
  groupActionItems,
  localDay,
  markTask,
  StaleTaskError,
  setTaskDone,
} from '@/lib/gitquire/board';
import {
  fetchObjects,
  fieldOf,
  fieldText,
  filterPages,
  matchesFilter,
  type ObjectList,
  type PageObject,
  sortPages,
  tableColumns,
} from '@/lib/gitquire/objects';
import { buildTimeline } from '@/lib/gitquire/timeline';
import {
  actionFilterOf,
  boardViewOf,
  parseViewBlock,
  tableViewOf,
  timelineViewOf,
  type ViewSpec,
} from '@/lib/gitquire/view-block';
import { cn } from '@/lib/utils';

const REUSE_MS = 5000;
const MAX_ROWS = 50;
const MAX_CARDS = 20;

let shared: { at: number; list: Promise<ObjectList> } | undefined;

function sharedObjects(): Promise<ObjectList> {
  const now = Date.now();
  if (shared === undefined || now - shared.at > REUSE_MS) {
    const list = fetchObjects();
    shared = { at: now, list };
    list.catch(() => {
      if (shared?.list === list) shared = undefined;
    });
  }
  return shared.list;
}

function forgetObjects(): void {
  shared = undefined;
}

function PageLink({ page, className }: { page: PageObject; className?: string }) {
  return (
    <a
      href={hashFromDocName(page.docName)}
      className={cn('underline-offset-2 hover:underline', className)}
    >
      {page.title}
    </a>
  );
}

function TableEmbed({ pages, spec }: { pages: PageObject[]; spec: ViewSpec }) {
  const { t } = useLingui();
  const view = tableViewOf(spec);
  const columns = tableColumns(pages, view);
  const rows = sortPages(filterPages(pages, view), view);
  const shown = rows.slice(0, MAX_ROWS);
  if (rows.length === 0) return <EmptyEmbed />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-start text-muted-foreground text-xs">
            <th className="px-2 py-1.5 text-start font-medium">{t`Page`}</th>
            {columns.map((column) => (
              <th key={column} className="px-2 py-1.5 text-start font-medium">
                {column}
              </th>
            ))}
            <th className="px-2 py-1.5 text-start font-medium">{t`Changed`}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((page) => (
            <tr key={page.docName} className="border-b last:border-b-0">
              <td className="px-2 py-1.5">
                <PageLink page={page} />
              </td>
              {columns.map((column) => (
                <td key={column} className="max-w-48 truncate px-2 py-1.5">
                  {fieldText(fieldOf(page, column))}
                </td>
              ))}
              <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                {formatRelativeAge(page.modified)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <p className="px-2 pt-2 text-muted-foreground text-xs">
          {t`Showing the first ${MAX_ROWS} pages.`}
        </p>
      )}
    </div>
  );
}

function BoardEmbed({ pages, spec }: { pages: PageObject[]; spec: ViewSpec }) {
  const { t } = useLingui();
  const view = boardViewOf(spec);
  const shown = pages.filter((page) => matchesFilter(page, view.filterKey, view.filterValue));
  const board = buildBoard(shown, view);
  if (board === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {t`No property with a few values to group by. Set "group:" in the view block.`}
      </p>
    );
  }
  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {board.columns.map((column) => (
        <section key={column.value} className="flex w-52 shrink-0 flex-col gap-2">
          <h4 className="font-medium text-muted-foreground text-xs">
            {column.value === '' ? t`No value` : column.value} · {column.pages.length}
          </h4>
          {column.pages.slice(0, MAX_CARDS).map((page) => (
            <PageLink
              key={page.docName}
              page={page}
              className="rounded-md border bg-background px-2.5 py-2 text-sm"
            />
          ))}
          {column.pages.length > MAX_CARDS && (
            <p className="text-muted-foreground text-xs">
              {plural(column.pages.length - MAX_CARDS, { one: '# more', other: '# more' })}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

function TimelineEmbed({ pages, spec }: { pages: PageObject[]; spec: ViewSpec }) {
  const months = buildTimeline(pages, timelineViewOf(spec));
  if (months.length === 0) return <EmptyEmbed />;
  return (
    <ol className="flex flex-col gap-1.5 text-sm">
      {months
        .flatMap((month) => month.entries)
        .slice(0, MAX_ROWS)
        .map((entry) => (
          <li key={entry.page.docName} className="flex flex-wrap items-baseline gap-x-3">
            <time dateTime={entry.day} className="w-24 shrink-0 text-muted-foreground text-xs">
              {entry.day}
            </time>
            <PageLink page={entry.page} />
            {entry.open > 0 && (
              <span className="text-muted-foreground text-xs">
                {plural(entry.open, { one: '# open item', other: '# open items' })}
              </span>
            )}
          </li>
        ))}
    </ol>
  );
}

function ActionsEmbed({
  pages,
  spec,
  onChange,
}: {
  pages: PageObject[];
  spec: ViewSpec;
  onChange: (pages: PageObject[]) => void;
}) {
  const { t } = useLingui();
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const today = localDay(new Date());
  const filter = actionFilterOf(spec);
  const scoped = pages.filter((page) => matchesFilter(page, spec.filterKey, spec.filterValue));
  const items = filterActionItems(actionItems(scoped), filter).slice(0, MAX_ROWS);
  const groups = groupActionItems(items, filter.grouping, today);
  if (groups.length === 0) return <EmptyEmbed />;

  function toggle(item: ActionItem, done: boolean) {
    if (saving.has(item.id)) return;
    setSaving((current) => new Set(current).add(item.id));
    const settle = () =>
      setSaving((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    setTaskDone(item, done).then(
      (source) => {
        settle();
        forgetObjects();
        onChange(markTask(pages, item, done, source));
      },
      (err: unknown) => {
        settle();
        toast.error(
          err instanceof StaleTaskError
            ? t`That action item changed on its page. Reload to see it.`
            : t`Couldn't save the action item.`,
        );
      },
    );
  }

  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {groups.flatMap((group) =>
        group.items.map((item) => {
          const text = item.text;
          const overdue = dueBucket(item, today) === 'overdue';
          return (
            <li key={`${group.key}:${item.id}`} className="flex flex-wrap items-start gap-x-2">
              <Checkbox
                checked={item.done}
                disabled={saving.has(item.id) || item.source === undefined}
                aria-label={item.done ? t`Reopen: ${text}` : t`Mark done: ${text}`}
                onCheckedChange={(checked) => toggle(item, checked === true)}
                className="mt-0.5"
              />
              <span
                className={cn('min-w-0 flex-1', item.done && 'text-muted-foreground line-through')}
              >
                {text}
              </span>
              {item.due !== undefined && (
                <span
                  className={cn('text-xs', overdue ? 'text-destructive' : 'text-muted-foreground')}
                >
                  {item.due}
                </span>
              )}
              <a
                href={hashFromDocName(item.docName)}
                className="text-muted-foreground text-xs underline-offset-2 hover:underline"
              >
                {item.pageTitle}
              </a>
            </li>
          );
        }),
      )}
    </ul>
  );
}

function EmptyEmbed() {
  const { t } = useLingui();
  return <p className="text-muted-foreground text-sm">{t`No pages match this view.`}</p>;
}

export function GitQuireViewBlock({
  source,
  codeShown,
  onEdit,
}: {
  source: string;
  codeShown: boolean;
  onEdit?: () => void;
}) {
  const { t } = useLingui();
  const spec = parseViewBlock(source);
  const [pages, setPages] = useState<PageObject[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    sharedObjects().then(
      (list) => {
        if (live) setPages(list.pages);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const names: Record<ViewSpec['view'], string> = {
    table: t`Table`,
    board: t`Board`,
    timeline: t`Timeline`,
    actions: t`Action items`,
  };

  return (
    <section
      aria-label={t`Saved view: ${names[spec.view]}`}
      className={cn(
        'not-prose flex flex-col gap-2 border bg-muted/30 p-3',
        codeShown ? 'rounded-t-lg border-b-0' : 'rounded-lg',
      )}
    >
      <div className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
        <LayoutList aria-hidden="true" className="size-3" />
        {names[spec.view]}
        {onEdit !== undefined && !codeShown && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ms-auto h-6 gap-1 px-2 text-xs"
            onClick={onEdit}
          >
            <Pencil aria-hidden="true" className="size-3" />
            {t`Edit view`}
          </Button>
        )}
      </div>
      {failed ? (
        <p className="text-destructive text-sm">{t`Couldn't load the pages for this view.`}</p>
      ) : pages === null ? (
        <p className="text-muted-foreground text-sm">{t`Loading…`}</p>
      ) : spec.view === 'table' ? (
        <TableEmbed pages={pages} spec={spec} />
      ) : spec.view === 'board' ? (
        <BoardEmbed pages={pages} spec={spec} />
      ) : spec.view === 'timeline' ? (
        <TimelineEmbed pages={pages} spec={spec} />
      ) : (
        <ActionsEmbed pages={pages} spec={spec} onChange={setPages} />
      )}
    </section>
  );
}
