import { plural, t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef } from 'react';
import type { RelationName } from '@/lib/gitquire/typed-links';

interface RelationSuggestionMenuProps {
  items: RelationName[];
  query: string;
  selectedIndex: number;
  onSelect: (item: RelationName) => void;
  onHover?: (index: number) => void;
  loading?: boolean;
  known: number;
}

function announcementText(item: RelationName): string {
  const uses = plural(item.count, { one: '# link', other: '# links' });
  const name = item.name;
  return t`Relation ${name}, ${uses}`;
}

const POPUP_CLASS = 'w-64 rounded-lg border bg-popover p-2 shadow-md text-sm text-muted-foreground';

export function RelationSuggestionMenu({
  items,
  query,
  selectedIndex,
  onSelect,
  onHover,
  loading = false,
  known,
}: RelationSuggestionMenuProps) {
  const { t } = useLingui();
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const activeDescendant =
    selectedIndex >= 0 && selectedIndex < items.length
      ? `${listboxId}-option-${selectedIndex}`
      : undefined;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const selected = container.querySelectorAll('[role="option"]').item(selectedIndex);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const preventFocusSteal = (e: React.MouseEvent) => e.preventDefault();
  const style = { maxHeight: 'var(--suggestion-menu-max-height, 40vh)' };

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={POPUP_CLASS}
        style={style}
        onMouseDown={preventFocusSteal}
      >
        <Trans>Loading relation names</Trans>
      </div>
    );
  }

  if (items.length === 0) {
    if (known === 0) return null;
    const trimmed = query.trim();
    return (
      <div
        role="status"
        aria-live="polite"
        className={POPUP_CLASS}
        style={style}
        onMouseDown={preventFocusSteal}
        data-testid="relation-suggestion-empty"
      >
        {t`No relation is named like "${trimmed}" yet. Keep typing to use it as a new one.`}
      </div>
    );
  }

  const selectedItem =
    selectedIndex >= 0 && selectedIndex < items.length ? items[selectedIndex] : null;

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={t`Relation suggestions`}
      aria-activedescendant={activeDescendant}
      tabIndex={-1}
      onMouseDown={preventFocusSteal}
      className="w-64 overflow-y-auto subtle-scrollbar rounded-lg border bg-popover p-1 shadow-md"
      style={style}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {selectedItem ? announcementText(selectedItem) : ''}
      </span>
      {items.map((item, idx) => {
        const isSelected = idx === selectedIndex;
        return (
          <button
            key={item.name}
            id={`${listboxId}-option-${idx}`}
            type="button"
            role="option"
            aria-selected={isSelected}
            data-selected={isSelected}
            data-testid={`relation-suggestion-${item.name}`}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left ${
              isSelected ? 'bg-accent text-accent-foreground' : ''
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
            onPointerMove={onHover ? () => onHover(idx) : undefined}
          >
            <span className="truncate font-medium flex-1">{item.name}</span>
            <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
              ::
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {item.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
