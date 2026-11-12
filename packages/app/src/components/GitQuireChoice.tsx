import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const EMPTY_CHOICE = '@empty';

export interface Choice {
  value: string;
  label: string;
}

export function ChoiceSelect({
  label,
  value,
  choices,
  disabled = false,
  className,
  onChange,
}: {
  label: string;
  value: string;
  choices: readonly Choice[];
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value === '' ? EMPTY_CHOICE : value}
      disabled={disabled}
      onValueChange={(next) => onChange(next === EMPTY_CHOICE ? '' : next)}
    >
      <SelectTrigger size="sm" aria-label={label} className={cn('max-w-56', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value === '' ? EMPTY_CHOICE : choice.value}>
            <span className="truncate">{choice.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
