import { useLingui } from '@lingui/react/macro';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import type { PageItem } from '@/editor/extensions/wiki-link-suggestion';
import type { PropertyLinkPicker } from './property-link-picker';

export function PropertyLinkPickerList({
  picker,
  onChoose,
}: {
  picker: PropertyLinkPicker;
  onChoose: (page: PageItem) => void;
}) {
  const { t } = useLingui();
  const listId = useId();
  if (!picker.open) return null;
  return (
    <div
      role="listbox"
      id={listId}
      aria-label={t`Pages to link`}
      data-testid="property-link-picker"
      className="absolute top-full start-0 z-50 mt-1 w-64 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
      style={{ maxHeight: '40vh' }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {picker.items.map((page, index) => {
        const selected = index === picker.selectedIndex;
        return (
          <Button
            key={page.docName}
            type="button"
            variant="ghost"
            role="option"
            aria-selected={selected}
            data-testid={`property-link-option-${page.docName}`}
            className={`h-auto w-full flex-col items-start gap-0 rounded-md px-2 py-1.5 text-start text-sm font-normal ${
              selected ? 'bg-accent text-accent-foreground' : ''
            }`}
            onMouseDown={(event) => {
              event.preventDefault();
              onChoose(page);
            }}
            onPointerMove={() => picker.hover(index)}
          >
            <span className="w-full truncate font-medium">{page.title || page.docName}</span>
            {page.title !== page.docName && (
              <span className="w-full truncate text-xs text-muted-foreground">{page.docName}</span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
