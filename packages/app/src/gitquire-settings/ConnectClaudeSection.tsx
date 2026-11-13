import { Trans, useLingui } from '@lingui/react/macro';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type GitQuireFeatures, useGitQuireFeatures } from '@/lib/gitquire/features';

export const CLAUDE_CONNECTORS_URL = 'https://claude.ai/customize/connectors';
export const CLAUDE_ORG_CONNECTORS_URL = 'https://claude.ai/admin-settings/connectors';
export const AGENT_ACCESS_PATH = '/auth/agents';

export function connectorUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

export type ConnectClaudeMode = 'connector' | 'token-only' | 'unavailable';

export function connectClaudeMode(features: GitQuireFeatures): ConnectClaudeMode {
  if (features.connector) return 'connector';
  if (features.agentToken) return 'token-only';
  return 'unavailable';
}

function CopyField({ value, label }: { value: string; label: string }) {
  const { t } = useLingui();
  const inputId = useId();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <Input
        id={inputId}
        readOnly
        value={value}
        className="font-mono text-1sm"
        onFocus={(event) => event.currentTarget.select()}
        data-testid="connect-claude-url"
      />
      <Button type="button" variant="outline" size="sm" onClick={copy} className="shrink-0 gap-1">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? t`Copied` : t`Copy`}
      </Button>
    </div>
  );
}

function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="outline" size="sm" className="gap-1">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
    </Button>
  );
}

function ConnectorSteps({ url }: { url: string }) {
  const { t } = useLingui();
  return (
    <ol className="list-decimal space-y-4 pl-5 text-sm" data-testid="connect-claude-steps">
      <li className="space-y-2">
        <p>
          <Trans>Copy this address:</Trans>
        </p>
        <CopyField value={url} label={t`GitQuire connector address`} />
      </li>
      <li className="space-y-2">
        <p>
          <Trans>
            In Claude, open <strong>Customize → Connectors</strong>, click <strong>+</strong> and
            choose <strong>Add custom connector</strong>. Name it GitQuire, paste the address and
            click <strong>Add</strong>.
          </Trans>
        </p>
        <ExternalButton href={CLAUDE_CONNECTORS_URL}>
          <Trans>Open Claude connectors</Trans>
        </ExternalButton>
      </li>
      <li>
        <p>
          <Trans>
            Click <strong>Connect</strong>. A window opens where you sign in with GitHub and approve
            access. That's it: Claude can now read and edit this wiki as you, on the web, in the
            desktop app and on your phone.
          </Trans>
        </p>
      </li>
    </ol>
  );
}

export function ConnectClaudeSection({
  origin = typeof window === 'undefined' ? '' : window.location.origin,
}: {
  origin?: string;
}) {
  const features = useGitQuireFeatures();
  const mode = connectClaudeMode(features);
  const titleId = useId();
  const url = connectorUrl(origin);

  return (
    <section aria-labelledby={titleId} className="space-y-6" data-testid="connect-claude-section">
      <SettingsSectionHeader titleId={titleId} title={<Trans>Connect Claude</Trans>}>
        <Trans>
          Let Claude work in this wiki with you. Its edits appear live for everyone and are
          committed with you as the author, and it sees the open comment threads on each page.
        </Trans>
      </SettingsSectionHeader>

      {mode === 'connector' ? <ConnectorSteps url={url} /> : null}

      {mode === 'token-only' ? (
        <p className="text-sm text-muted-foreground" data-testid="connect-claude-token-only">
          <Trans>
            This server is not set up for Claude on the web and on phones yet (it needs
            GITQUIRE_MCP_CONNECTORS=on and a public HTTPS address). You can still connect Claude
            Code with a personal token.
          </Trans>
        </p>
      ) : null}

      {mode === 'unavailable' ? (
        <p className="text-sm text-muted-foreground" data-testid="connect-claude-unavailable">
          <Trans>
            Connecting Claude needs GitHub sign-in on this server. See DEPLOY.md for how to set it
            up.
          </Trans>
        </p>
      ) : null}

      {mode !== 'unavailable' ? (
        <div className="space-y-2 border-t pt-4 text-sm">
          <p className="text-muted-foreground">
            {mode === 'connector' ? (
              <Trans>
                Using a Team or Enterprise plan? An owner adds the connector once under Organization
                settings → Connectors, then everyone clicks Connect. For Claude Code, create a
                personal token instead.
              </Trans>
            ) : (
              <Trans>Create a token, then run the command shown in Claude Code.</Trans>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={AGENT_ACCESS_PATH} target="_blank" rel="noreferrer">
                <Trans>Tokens and connected apps</Trans>
              </a>
            </Button>
            {mode === 'connector' ? (
              <ExternalButton href={CLAUDE_ORG_CONNECTORS_URL}>
                <Trans>Organization connectors</Trans>
              </ExternalButton>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
