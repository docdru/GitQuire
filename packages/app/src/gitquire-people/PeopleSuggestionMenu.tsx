import { useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef } from 'react';
import type { Person } from '@/lib/gitquire/people';
import { PersonOption } from './PersonOption';

export function PeopleSuggestionMenu({
  people,
  selectedIndex,
  onSelect,
  onHover,
}: {
  people: readonly Person[];
  selectedIndex: number;
  onSelect: (person: Person) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useLingui();
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const option = containerRef.current?.querySelectorAll('[role="option"]').item(selectedIndex);
    option?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (people.length === 0) return null;
  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={t`People`}
      aria-activedescendant={`${listId}-${selectedIndex}`}
      tabIndex={-1}
      className="w-64 overflow-y-auto subtle-scrollbar rounded-lg border bg-popover p-1 shadow-md"
      style={{ maxHeight: 'var(--suggestion-menu-max-height, 40vh)' }}
      onMouseDown={(event) => event.preventDefault()}
      data-testid="people-suggestion"
    >
      {people.map((person, index) => (
        <PersonOption
          key={person.login}
          id={`${listId}-${index}`}
          person={person}
          selected={index === selectedIndex}
          onPick={() => onSelect(person)}
          onHover={() => onHover(index)}
        />
      ))}
    </div>
  );
}
