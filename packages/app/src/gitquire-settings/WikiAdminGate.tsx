import { useLingui } from '@lingui/react/macro';
import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useGitQuireFeatures } from '@/lib/gitquire/features';
import { isWikiAdminSetting } from '@/lib/gitquire/settings-visibility';

export function WikiAdminGateView({
  admin,
  logins,
  repo,
  children,
}: {
  admin: boolean;
  logins: readonly string[];
  repo: string | null;
  children: ReactNode;
}) {
  const { t, i18n } = useLingui();
  if (admin) return children;
  const names = new Intl.ListFormat(i18n.locale, { type: 'disjunction' }).format(
    logins.map((login) => `@${login}`),
  );
  const note =
    logins.length > 0 && repo !== null
      ? t`Only wiki admins can change these settings. Ask ${names}, or a maintainer of ${repo}.`
      : logins.length > 0
        ? t`Only wiki admins can change these settings. Ask ${names}.`
        : repo !== null
          ? t`Only maintainers of ${repo} can change these settings.`
          : t`Only wiki admins can change these settings.`;
  return (
    <div className="space-y-4" data-testid="wiki-admin-read-only">
      <p
        role="note"
        className="flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
      >
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{note}</span>
      </p>
      <fieldset disabled inert className="min-w-0 opacity-60" aria-label={t`Read-only settings`}>
        {children}
      </fieldset>
    </div>
  );
}

export function WikiAdminGate({ itemId, children }: { itemId: string; children: ReactNode }) {
  const features = useGitQuireFeatures();
  if (!isWikiAdminSetting(itemId)) return children;
  return (
    <WikiAdminGateView
      admin={features.settingsAdmin}
      logins={features.adminLogins}
      repo={features.adminRepo}
    >
      {children}
    </WikiAdminGateView>
  );
}
