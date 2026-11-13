import { Trans, useLingui } from '@lingui/react/macro';
import { useId } from 'react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { useGitQuireFeatures } from '@/lib/gitquire/features';
import {
  CopyField,
  connectClaudeMode,
  connectorUrl,
  ExternalButton,
  pageOrigin,
} from './ConnectClaudeSection';

export const LE_CHAT_URL = 'https://chat.mistral.ai/';
export const MISTRAL_CONNECTOR_NAME = 'gitquire';

export function ConnectMistralSection({ origin }: { origin?: string }) {
  const { t } = useLingui();
  const features = useGitQuireFeatures();
  const titleId = useId();
  if (connectClaudeMode(features) !== 'connector') return null;
  const url = connectorUrl(origin ?? pageOrigin());

  return (
    <section aria-labelledby={titleId} className="space-y-6" data-testid="connect-mistral-section">
      <SettingsSectionHeader titleId={titleId} title={<Trans>Connect Mistral</Trans>}>
        <Trans>
          Let Mistral's Le Chat work in this wiki with you, the same way as Claude: its edits are
          committed with you as the author.
        </Trans>
      </SettingsSectionHeader>

      <ol className="list-decimal space-y-4 ps-5 text-sm" data-testid="connect-mistral-steps">
        <li className="space-y-2">
          <p>
            <Trans>Copy this address:</Trans>
          </p>
          <CopyField
            value={url}
            label={t`GitQuire connector address for Le Chat`}
            testId="connect-mistral-url"
          />
        </li>
        <li className="space-y-2">
          <p>
            <Trans>
              In Le Chat, open <strong>Intelligence → Connectors</strong>, click{' '}
              <strong>+ Add Connector</strong> and switch to <strong>Custom MCP Connector</strong>.
              Name it <code>{MISTRAL_CONNECTOR_NAME}</code> (no spaces), paste the address and click{' '}
              <strong>Connect</strong>.
            </Trans>
          </p>
          <ExternalButton href={LE_CHAT_URL}>
            <Trans>Open Le Chat</Trans>
          </ExternalButton>
        </li>
        <li>
          <p>
            <Trans>
              A window opens where you sign in with GitHub and approve access. Le Chat can then use
              the wiki in every chat where the connector is turned on.
            </Trans>
          </p>
        </li>
      </ol>

      <p className="text-sm text-muted-foreground">
        <Trans>
          Only Le Chat administrators can add connectors. On the Free, Pro and Student plans, that is
          the account owner.
        </Trans>
      </p>
    </section>
  );
}
