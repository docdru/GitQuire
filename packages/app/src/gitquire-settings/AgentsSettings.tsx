import type { ReactNode } from 'react';
import { useGitQuireFeatures } from '@/lib/gitquire/features';
import { ConnectAiSection } from './ConnectAiSection';

export function AgentsSettings({ inAppAgents }: { inAppAgents: ReactNode }) {
  const { askAi } = useGitQuireFeatures();
  return (
    <div className="space-y-10">
      <ConnectAiSection />
      {askAi ? inAppAgents : null}
    </div>
  );
}
