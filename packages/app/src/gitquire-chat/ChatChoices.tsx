import { useLingui } from '@lingui/react/macro';
import { useId } from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ChatOverview } from '@/lib/gitquire/chat-api';
import { useChatEdits } from '@/lib/gitquire/chat-edit-target';
import { chooseChatModel, pickSelection, useChosenChatModel } from '@/lib/gitquire/chat-model';
import { cn } from '@/lib/utils';

const SELECTED_TOGGLE_CLASS =
  'text-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90';

export function ChatEditsToggle({ compact = false }: { compact?: boolean }) {
  const { t } = useLingui();
  const chatEdits = useChatEdits();
  const labelId = useId();
  if (!chatEdits.available) return null;
  return (
    <div className="flex items-center gap-1.5" data-testid="gitquire-chat-edits">
      <span id={labelId} className={cn('text-muted-foreground text-xs', compact && 'sr-only')}>
        {t`Edits go to:`}
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={chatEdits.value}
        onValueChange={(value) => {
          if (value === 'live' || value === 'draft') chatEdits.choose(value);
        }}
        aria-labelledby={labelId}
      >
        <ToggleGroupItem value="live" className={SELECTED_TOGGLE_CLASS}>
          {t`Live wiki`}
        </ToggleGroupItem>
        <ToggleGroupItem value="draft" className={SELECTED_TOGGLE_CLASS}>
          {t`Draft`}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

export function ChatModelSelect({
  overview,
  disabled = false,
  className,
}: {
  overview: ChatOverview;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  const selection = pickSelection(overview, useChosenChatModel());
  const usable = overview.providers.filter((provider) => provider.key.configured);
  if (selection === null) return null;
  return (
    <Select
      value={`${selection.provider}:${selection.model}`}
      onValueChange={(value) => {
        const [provider, ...rest] = value.split(':');
        if (provider !== 'claude' && provider !== 'mistral') return;
        chooseChatModel({ provider, model: rest.join(':') });
      }}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className={cn('h-7 w-auto min-w-0 text-xs', className)}
        aria-label={t`Model`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {usable.map((provider) => (
          <SelectGroup key={provider.id}>
            <SelectLabel>{provider.label}</SelectLabel>
            {provider.models.map((model) => (
              <SelectItem key={model.id} value={`${provider.id}:${model.id}`}>
                {model.label}
                <span className="ms-1 text-muted-foreground">
                  ·{' '}
                  {model.tier === 'capable'
                    ? t`Most capable, costs more`
                    : model.tier === 'fast'
                      ? t`Fastest, cheapest`
                      : t`Balanced`}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
