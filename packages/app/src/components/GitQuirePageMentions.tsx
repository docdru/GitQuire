import { useLingui } from '@lingui/react/macro';
import { type Choice, ChoiceSelect } from '@/components/GitQuireChoice';
import { Button } from '@/components/ui/button';
import { PageMentionRows, usePageMentions } from '@/gitquire-people/PageMentionList';
import {
  ANYONE,
  mentionedPeople,
  mentionsOfPerson,
  type PageMention,
} from '@/lib/gitquire/page-mentions';

export const ME = '@me';

export function PageMentionsView({
  active,
  me,
  person,
  onPerson,
  onOpen,
}: {
  active: boolean;
  me: string | null;
  person: string;
  onPerson: (person: string) => void;
  onOpen: (mention: PageMention) => void;
}) {
  const { t } = useLingui();
  const { data, reload } = usePageMentions(active);
  const mine = me?.toLowerCase() ?? '';
  const all = data.state === 'loaded' ? data.list.mentions : [];
  const chosen = person === ME && mine === '' ? ANYONE : person;
  const wanted = chosen === ME ? mine : chosen;
  const shown = mentionsOfPerson(all, wanted);
  const choices: Choice[] = [
    { value: ANYONE, label: t`Anyone` },
    ...(mine === '' ? [] : [{ value: ME, label: t`Me (@${mine})` }]),
    ...mentionedPeople(all)
      .filter((entry) => entry.login !== mine)
      .map((entry) => {
        const login = entry.login;
        const count = entry.count;
        return { value: login, label: t`@${login} (${count})` };
      }),
  ];
  if (chosen !== ANYONE && chosen !== ME && !choices.some((choice) => choice.value === chosen)) {
    choices.push({ value: chosen, label: `@${chosen}` });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="page-mentions-view">
      <div className="flex flex-wrap items-center gap-2">
        <ChoiceSelect label={t`Person`} value={chosen} choices={choices} onChange={onPerson} />
        <p className="text-muted-foreground text-xs">
          {t`Mentions in the text of pages. They do not notify anyone; mentions in comments and action items do.`}
        </p>
      </div>
      {data.state === 'loading' && <p className="text-muted-foreground text-sm">{t`Loading…`}</p>}
      {data.state === 'failed' && (
        <p className="flex items-center gap-2 text-destructive text-sm">
          {t`Couldn't load the mentions in pages.`}
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t`Try again`}
          </Button>
        </p>
      )}
      {data.state === 'loaded' && shown.length === 0 && (
        <p className="text-muted-foreground text-sm">{t`No mentions in pages match.`}</p>
      )}
      {data.state === 'loaded' && shown.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PageMentionRows mentions={shown} showPerson={wanted === ANYONE} onOpen={onOpen} />
          {data.list.truncated && (
            <p className="text-muted-foreground text-xs">
              {t`This wiki has more mentions than the list can show; it is cut off.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
