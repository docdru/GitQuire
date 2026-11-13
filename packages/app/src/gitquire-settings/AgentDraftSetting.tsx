import { useLingui } from '@lingui/react/macro';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { type AgentMode, fetchAgentMode, saveAgentMode } from '@/lib/gitquire/drafts-api';
import { useDraftState } from '@/lib/gitquire/drafts-store';

export function AgentDraftSetting() {
  const { t } = useLingui();
  const { list } = useDraftState();
  const switchId = useId();
  const [mode, setMode] = useState<AgentMode | null>(null);
  const enabled = list?.enabled === true;

  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    fetchAgentMode().then(
      (value) => {
        if (!stale) setMode(value);
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [enabled]);

  if (!enabled || mode === null) return null;

  async function change(checked: boolean) {
    const next: AgentMode = checked ? 'draft' : 'live';
    setMode(next);
    try {
      setMode(await saveAgentMode(next));
    } catch {
      setMode(checked ? 'live' : 'draft');
      toast.error(t`Couldn't save the setting. Try again.`);
    }
  }

  return (
    <div
      className="flex items-start justify-between gap-4 border-t pt-4"
      data-testid="agent-draft-setting"
    >
      <div className="space-y-1 text-sm">
        <Label htmlFor={switchId}>{t`Put my AI assistant's edits into a draft`}</Label>
        <p className="text-muted-foreground">
          {t`When this is on, your assistant works in the draft you have open, or in its own draft for you to review and publish. When it is off, its edits go straight to the live wiki.`}
        </p>
      </div>
      <Switch
        id={switchId}
        checked={mode === 'draft'}
        onCheckedChange={(checked) => void change(checked)}
      />
    </div>
  );
}
