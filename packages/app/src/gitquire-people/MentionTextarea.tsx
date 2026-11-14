import { useLingui } from '@lingui/react/macro';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import {
  insertMention,
  matchPeople,
  mentionQueryAt,
  type Person,
  usePeople,
} from '@/lib/gitquire/people';
import { PersonOption } from './PersonOption';

interface MentionTextareaProps {
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
}

interface OpenQuery {
  start: number;
  query: string;
}

export function MentionTextarea({
  value,
  onValueChange,
  onKeyDown,
  ...textareaProps
}: MentionTextareaProps) {
  const { t } = useLingui();
  const { people } = usePeople();
  const listId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState<OpenQuery | null>(null);
  const [selected, setSelected] = useState(0);
  const matches = open === null ? [] : matchPeople(people, open.query);
  const showing = open !== null && matches.length > 0;

  function track(text: string, caret: number) {
    const found = mentionQueryAt(text, caret);
    setOpen(found);
    if (found?.query !== open?.query) setSelected(0);
  }

  function choose(person: Person) {
    const textarea = textareaRef.current;
    if (textarea === null || open === null) return;
    const caret = textarea.selectionStart ?? value.length;
    const next = insertMention(value, open.start, caret, person.login);
    onValueChange(next.text);
    setOpen(null);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(next.caret, next.caret);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (showing && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSelected((index) => (index + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
        const person = matches[selected];
        if (person !== undefined) {
          event.preventDefault();
          choose(person);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(null);
        return;
      }
    }
    onKeyDown?.(event);
  }

  return (
    <div className="relative">
      <Textarea
        {...textareaProps}
        ref={textareaRef}
        value={value}
        role="combobox"
        aria-expanded={showing}
        aria-controls={showing ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={showing ? `${listId}-${selected}` : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          track(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={(event) => {
          const target = event.currentTarget;
          track(target.value, target.selectionStart ?? target.value.length);
        }}
        onBlur={() => setOpen(null)}
        onKeyDown={handleKeyDown}
      />
      {showing && (
        <div
          id={listId}
          role="listbox"
          aria-label={t`People`}
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
          onMouseDown={(event) => event.preventDefault()}
          data-testid="mention-picker"
        >
          {matches.map((person, index) => (
            <PersonOption
              key={person.login}
              id={`${listId}-${index}`}
              person={person}
              selected={index === selected}
              onPick={() => choose(person)}
              onHover={() => setSelected(index)}
            />
          ))}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {showing ? t`${matches.length} people match. Use the arrow keys and Enter to pick.` : ''}
      </span>
    </div>
  );
}
