import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { publishAskComposerHeight } from '@/editor/ask-composer-inset';
import {
  buildClaudePrompt,
  CLAUDE_DESTINATIONS,
  type ClaudeDestination,
  claudeLink,
  defaultDestination,
  isClaudeDestination,
  loadStoredDestination,
  MAX_REQUEST_CHARS,
  openClaudeLink,
  storeDestination,
} from '@/lib/gitquire/ask-claude';
import { useGitQuireFeatures } from '@/lib/gitquire/features';
import { cn } from '@/lib/utils';
import { docNameToRelativePath } from '@/lib/workspace-paths';

const HEIGHT_RESERVE_PX = 56;

export function GitQuireAskClaude({
  docName,
  folderPath,
  dismissed = false,
  onDismiss,
}: {
  docName?: string | null;
  folderPath?: string;
  dismissed?: boolean;
  onDismiss?: () => void;
}) {
  const { t } = useLingui();
  const features = useGitQuireFeatures();
  const folderMode = folderPath !== undefined;
  const [text, setText] = useState('');
  const [destination, setDestination] = useState<ClaudeDestination>(() =>
    defaultDestination(features, loadStoredDestination()),
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (folderMode || dismissed) return;
    const card = cardRef.current;
    if (card === null) return;
    const apply = () => publishAskComposerHeight(card.offsetHeight + HEIGHT_RESERVE_PX);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(card);
    return () => {
      observer.disconnect();
      publishAskComposerHeight(null);
    };
  }, [dismissed, folderMode]);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }, [text]);

  const labels: Record<ClaudeDestination, string> = {
    'claude-web': t`Claude on the web or phone`,
    'claude-app': t`Claude desktop app`,
    'claude-code': t`Claude Code in the desktop app`,
  };

  if (dismissed) return null;

  const canSend = text.trim() !== '';
  const placeholder = folderMode
    ? t`Ask Claude to work on this folder…`
    : t`Ask Claude to work on this page…`;

  const submit = () => {
    if (!canSend) return;
    const target =
      folderMode || docName == null
        ? { kind: 'folder' as const, path: folderPath ?? '' }
        : { kind: 'page' as const, path: docNameToRelativePath(docName) };
    const prompt = buildClaudePrompt({ wikiUrl: window.location.origin, target, request: text });
    openClaudeLink(claudeLink(destination, prompt));
    setText('');
    toast.success(t`Claude opened with your request. Check it there and press send.`);
  };

  const card = (
    <div
      ref={cardRef}
      data-testid="gitquire-ask-claude"
      className="pointer-events-auto flex flex-col gap-1.5 rounded-2xl border border-border/60 bg-card px-3 py-2 shadow-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
    >
      <div className="flex items-start gap-2">
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          maxLength={MAX_REQUEST_CHARS}
          aria-label={t`Ask Claude`}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="min-h-8 flex-1 resize-none bg-transparent py-1.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
        {onDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={t`Hide`}
            onClick={onDismiss}
          >
            <X aria-hidden className="size-4" />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          value={destination}
          onValueChange={(value) => {
            if (!isClaudeDestination(value)) return;
            setDestination(value);
            storeDestination(value);
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-auto max-w-full"
            aria-label={t`Where to open Claude`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLAUDE_DESTINATIONS.map((id) => (
              <SelectItem key={id} value={id}>
                {labels[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" size="sm" disabled={!canSend} onClick={submit}>
          <Trans>Open in Claude</Trans>
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  if (folderMode) {
    return (
      <div className="shrink-0 pt-2 pb-3">
        <div className="mx-auto w-full max-w-4xl px-6">{card}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-[var(--conflict-footer-height,0px)] z-20 editor-content-aligned',
        'bg-gradient-to-t from-background from-65% via-background to-transparent pt-10 pb-2',
      )}
    >
      {card}
    </div>
  );
}
