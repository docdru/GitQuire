import { useLingui } from '@lingui/react/macro';
import { Folder } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useGitQuireRepository } from '@/lib/gitquire/repository';
import { extractFolderBasename } from '@/lib/path-utils';
import { useWorkspace } from '@/lib/use-workspace';

const CENTRE_LABEL_CLASS = 'flex min-w-0 items-center gap-1.5 px-2 text-foreground text-sm';

export function WebProjectName() {
  const { t } = useLingui();
  const workspace = useWorkspace();
  const repository = useGitQuireRepository();

  if (repository !== null) {
    const fullName = `${repository.owner}/${repository.name}`;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={repository.url}
            target="_blank"
            rel="noreferrer"
            data-testid="web-project-name"
            className={`${CENTRE_LABEL_CLASS} rounded-md hover:bg-accent`}
          >
            <Folder aria-hidden="true" className="size-4 shrink-0" />
            <span className="sr-only">{t`Repository`}</span>
            <span
              className="min-w-0 truncate"
              data-app-header-center-label=""
              data-testid="web-project-name-label"
            >
              {fullName}
            </span>
          </a>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs break-all">
          {t`Open ${fullName} on GitHub`}
        </TooltipContent>
      </Tooltip>
    );
  }

  if (workspace === null) return null;
  const name = extractFolderBasename(workspace.contentDir) || null;
  if (name === null) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- tooltip-on-static-text pattern — focusable span lets keyboard users surface the full project path that mouse users see on hover.
          tabIndex={0}
          data-testid="web-project-name"
          className={CENTRE_LABEL_CLASS}
        >
          <Folder aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only">{t`Project`}</span>
          <span
            className="min-w-0 truncate"
            data-app-header-center-label=""
            data-testid="web-project-name-label"
          >
            {name}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs break-all">
        {workspace.contentDir}
      </TooltipContent>
    </Tooltip>
  );
}
