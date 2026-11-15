import { WorkspaceSuccessSchema } from '@inkeep/open-knowledge-core/schemas/api';
import { useEffect, useState } from 'react';
import type { Workspace } from './workspace-paths';

export function useWorkspace(): Workspace | null {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    if (workspace !== null) return;
    let active = true;
    fetch('/api/workspace')
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!active) return;
        if (!res.ok) return;
        const parsed = WorkspaceSuccessSchema.safeParse(data);
        if (!parsed.success) return;
        setWorkspace({
          contentDir: parsed.data.contentDir,
          pathSeparator: parsed.data.pathSeparator,
        });
      })
      .catch((err) => {
        console.warn('[useWorkspace] /api/workspace fetch failed:', err);
      });
    return () => {
      active = false;
    };
  }, [workspace]);

  return workspace;
}
