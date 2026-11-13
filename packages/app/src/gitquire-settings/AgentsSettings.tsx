import type { ReactNode } from 'react';
import { useGitQuireFeatures } from '@/lib/gitquire/features';
import { ConnectClaudeSection } from './ConnectClaudeSection';

export function AgentsSettings({ inAppAgents }: { inAppAgents: ReactNode }) {
  const { askAi } = useGitQuireFeatures();
  return (
    <div className="space-y-10">
      <ConnectClaudeSection />
      {askAi ? inAppAgents : null}
    </div>
  );
}
