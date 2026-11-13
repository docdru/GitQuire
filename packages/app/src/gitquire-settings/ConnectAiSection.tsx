import { Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronRight, Copy, ExternalLink } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { type GitQuireFeatures, useGitQuireFeatures } from '@/lib/gitquire/features';

export const CLAUDE_CONNECTORS_URL = 'https://claude.ai/customize/connectors';
export const CLAUDE_ORG_CONNECTORS_URL = 'https://claude.ai/admin-settings/connectors';
export const LE_CHAT_URL = 'https://chat.mistral.ai/';
export const AGENT_ACCESS_PATH = '/auth/agents';

export function connectorUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

export type ConnectAiMode = 'connector' | 'token-only' | 'unavailable';

export function connectAiMode(features: GitQuireFeatures): ConnectAiMode {
  if (features.canConnect) return 'connector';
  if (features.canUseTokens) return 'token-only';
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
        data-testid="connect-ai-url"
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

function AssistantSteps({
  title,
  testId,
  children,
}: {
  title: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Collapsible className="rounded-md border" data-testid={testId}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-start text-sm font-medium">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 border-t px-3 py-3 text-sm">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ClaudeSteps() {
  return (
    <AssistantSteps title={<Trans>Claude</Trans>} testId="connect-ai-claude">
      <ol className="list-decimal space-y-3 ps-5">
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
          <Trans>
            Click <strong>Connect</strong>, sign in with GitHub and approve access. Claude can then
            work in the wiki on the web, in the desktop app and on your phone.
          </Trans>
        </li>
      </ol>
      <p className="text-muted-foreground">
        <Trans>
          On a Team or Enterprise plan, an owner adds the connector once under Organization settings
          → Connectors, then everyone clicks Connect.
        </Trans>
      </p>
      <ExternalButton href={CLAUDE_ORG_CONNECTORS_URL}>
        <Trans>Organization connectors</Trans>
      </ExternalButton>
    </AssistantSteps>
  );
}

function MistralSteps() {
  return (
    <AssistantSteps title={<Trans>Mistral Le Chat</Trans>} testId="connect-ai-mistral">
      <ol className="list-decimal space-y-3 ps-5">
        <li className="space-y-2">
          <p>
            <Trans>
              In Le Chat, open <strong>Intelligence → Connectors</strong>, click{' '}
              <strong>+ Add Connector</strong> and switch to <strong>Custom MCP Connector</strong>.
              Name it <code>gitquire</code> (no spaces), paste the address and click{' '}
              <strong>Connect</strong>.
            </Trans>
          </p>
          <ExternalButton href={LE_CHAT_URL}>
            <Trans>Open Le Chat</Trans>
          </ExternalButton>
        </li>
        <li>
          <Trans>
            Sign in with GitHub and approve access. Turn the connector on in a chat to let Le Chat
            use the wiki there.
          </Trans>
        </li>
      </ol>
      <p className="text-muted-foreground">
        <Trans>
          Only Le Chat administrators can add connectors. On the Free, Pro and Student plans, that
          is the account owner.
        </Trans>
      </p>
    </AssistantSteps>
  );
}

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function ConnectAiSection({ origin }: { origin?: string }) {
  const { t } = useLingui();
  const features = useGitQuireFeatures();
  const mode = connectAiMode(features);
  const titleId = useId();
  const url = connectorUrl(origin ?? pageOrigin());

  return (
    <section aria-labelledby={titleId} className="space-y-6" data-testid="connect-ai-section">
      <SettingsSectionHeader titleId={titleId} title={<Trans>Connect AI</Trans>}>
        <Trans>
          Let an AI assistant work in this wiki with you. Its edits appear live for everyone and are
          committed with you as the author, and it sees the open comment threads on each page.
        </Trans>
      </SettingsSectionHeader>

      {mode === 'connector' ? (
        <div className="space-y-4" data-testid="connect-ai-steps">
          <div className="space-y-2 text-sm">
            <p>
              <Trans>Copy this connector address, then follow the steps for your assistant:</Trans>
            </p>
            <CopyField value={url} label={t`GitQuire connector address`} />
          </div>
          <ClaudeSteps />
          <MistralSteps />
        </div>
      ) : null}

      {mode === 'token-only' ? (
        <p className="text-sm text-muted-foreground" data-testid="connect-ai-token-only">
          <Trans>
            This server is not set up for AI assistants on the web and on phones yet (it needs
            GITQUIRE_MCP_CONNECTORS=on and a public HTTPS address). You can still connect Claude
            Code with a personal token.
          </Trans>
        </p>
      ) : null}

      {mode === 'unavailable' ? (
        <p className="text-sm text-muted-foreground" data-testid="connect-ai-unavailable">
          <Trans>
            Connecting AI assistants needs GitHub sign-in on this server. See DEPLOY.md for how to
            set it up.
          </Trans>
        </p>
      ) : null}

      {mode !== 'unavailable' ? (
        <div className="space-y-2 border-t pt-4 text-sm">
          <p className="text-muted-foreground">
            <Trans>For Claude Code and other command-line agents, create a personal token.</Trans>
          </p>
          <Button asChild variant="outline" size="sm">
            <a href={AGENT_ACCESS_PATH} target="_blank" rel="noreferrer">
              <Trans>Tokens and connected apps</Trans>
            </a>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
