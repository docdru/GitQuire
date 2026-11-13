import type { Person } from '@/lib/gitquire/people';
import { cn } from '@/lib/utils';

export function PersonOption({
  id,
  person,
  selected,
  onPick,
  onHover,
}: {
  id: string;
  person: Person;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const initial = (person.name ?? person.login).slice(0, 1).toUpperCase();
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={selected}
      data-testid={`mention-option-${person.login}`}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm',
        selected && 'bg-accent text-accent-foreground',
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
      onPointerMove={onHover}
    >
      {person.avatarUrl === undefined ? (
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs"
        >
          {initial}
        </span>
      ) : (
        <img
          src={person.avatarUrl}
          alt=""
          className="size-5 shrink-0 rounded-full"
          referrerPolicy="no-referrer"
        />
      )}
      <span className="min-w-0 flex-1 truncate font-medium">{person.name ?? person.login}</span>
      <span className="shrink-0 text-muted-foreground text-xs">@{person.login}</span>
    </button>
  );
}
