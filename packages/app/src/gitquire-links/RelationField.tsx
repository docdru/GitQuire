import { Trans, useLingui } from '@lingui/react/macro';
import type { KeyboardEvent } from 'react';
import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { useTypedLinks } from '@/lib/gitquire/typed-links';
import { isValidRelationInput } from './relation-fields';

export function RelationField({
  value,
  onChange,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const listId = useId();
  const errorId = useId();
  const typedLinks = useTypedLinks();
  const valid = isValidRelationInput(value);
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium" htmlFor={inputId}>
        <Trans>
          Relation{' '}
          <span className="font-normal text-muted-foreground">
            (optional, such as supersedes or blocks)
          </span>
        </Trans>
      </label>
      <Input
        id={inputId}
        value={value}
        list={listId}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t`No relation`}
        aria-invalid={!valid}
        aria-describedby={valid ? undefined : errorId}
        data-testid="wiki-link-relation-input"
      />
      <datalist id={listId}>
        {typedLinks.relations.map((relation) => (
          <option key={relation.name} value={relation.name} />
        ))}
      </datalist>
      {valid ? null : (
        <p id={errorId} className="mt-1 text-xs text-destructive">
          <Trans>Use letters, digits, spaces and - _ . / (up to 60 characters).</Trans>
        </p>
      )}
    </div>
  );
}
