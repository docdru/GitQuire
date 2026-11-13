import type { ReactNode } from 'react';
import { useGitQuireFeatures } from '@/lib/gitquire/features';
import { ConnectClaudeSection } from './ConnectClaudeSection';
import { ConnectMistralSection } from './ConnectMistralSection';

export function AgentsSettings({ inAppAgents }: { inAppAgents: ReactNode }) {
  const { askAi } = useGitQuireFeatures();
  return (
    <div className="space-y-10">
      <ConnectClaudeSection />
      <ConnectMistralSection />
      {askAi ? inAppAgents : null}
    </div>
  );
}
