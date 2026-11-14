import { Trans } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export type SettingsScope = 'user' | 'project' | 'project-local';

export function ScopeBadge({ scope }: { scope: SettingsScope }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="gray"
            tabIndex={0}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`settings-scope-badge-${scope}`}
          >
            {scope === 'user' ? (
              <Trans>User</Trans>
            ) : scope === 'project-local' ? (
              <Trans>Whole wiki</Trans>
            ) : (
              <Trans>Project</Trans>
            )}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {scope === 'user' ? (
            <Trans>
              Personal to this device. Applies to every project you open here and is never shared
              with collaborators.
            </Trans>
          ) : scope === 'project-local' ? (
            <Trans>
              Applies to everyone using this wiki. Stored on the server in .ok/local, not in Git.
            </Trans>
          ) : (
            <Trans>
              Applies to everyone using this wiki. Stored in the repository and travels with it
              through git.
            </Trans>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
