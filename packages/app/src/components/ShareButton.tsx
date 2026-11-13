// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import { Trans, useLingui } from '@lingui/react/macro';
import { CircleHelp, Share2 } from 'lucide-react';
import { type Ref, useEffect, useId, useRef, useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { gitquirePageLink } from '@/lib/gitquire/page-link';
import { formatShortcutBinding, formatShortcutBindingLabel } from '@/lib/keyboard-shortcuts';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import type { ShareTargetInput } from '@/lib/share/run-share-action';

const SHARE_DOCS_URL = 'https://docdru.github.io/GitQuire/docs/features/share';
const COPY_SHORTCUT = { mac: '⌘ C', windowsLinux: 'Ctrl C' };

export interface ShareButtonProps {
  input: ShareTargetInput | null;
  onClickWhenNoRemote: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
}

export function ShareButton({ input, triggerRef }: ShareButtonProps) {
  const { t } = useLingui();
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [sharePopover, setSharePopover] = useState<{
    url: string;
    autoCopyFailed: boolean;
  } | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!sharePopover?.autoCopyFailed || !urlInputRef.current) return;
    urlInputRef.current.focus();
    urlInputRef.current.select();
  }, [sharePopover]);

  const triggerDisabled = input === null;
  const copyShortcut = formatShortcutBinding(COPY_SHORTCUT);
  const copyShortcutLabel = formatShortcutBindingLabel(COPY_SHORTCUT);

  async function handleClick() {
    if (busy) return;
    if (input === null) return;
    setBusy(true);
    setSharePopover(null);
    const url = gitquirePageLink(input, window.location);
    try {
      await scheduleClipboardWrite(url);
      setSharePopover({ url, autoCopyFailed: false });
    } catch {
      setSharePopover({ url, autoCopyFailed: true });
    }
    setBusy(false);
  }

  return (
    <Popover
      open={sharePopover !== null}
      onOpenChange={(open) => {
        if (!open) setSharePopover(null);
      }}
    >
      <PopoverAnchor asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          aria-label={input?.kind === 'folder' ? t`Share folder` : t`Share doc`}
          onClick={handleClick}
          disabled={busy || triggerDisabled}
          className="gap-1.5 text-muted-foreground px-1.5"
          data-testid="share-button"
        >
          <Share2 className="size-4" aria-hidden />
          <Trans>Share</Trans>
        </Button>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        aria-labelledby={headingId}
        className="flex w-80 flex-col gap-2"
        data-testid="share-button-popover"
      >
        <p
          id={headingId}
          className="font-mono tracking-wide uppercase text-muted-foreground text-xs"
        >
          <Trans>Share</Trans>
        </p>
        {sharePopover?.autoCopyFailed ? (
          <p className="text-xs text-muted-foreground">
            <Trans>
              Use <Kbd aria-label={copyShortcutLabel}>{copyShortcut}</Kbd> to copy the link below.
            </Trans>
          </p>
        ) : null}
        <div className="relative">
          <Input
            ref={urlInputRef}
            readOnly
            value={sharePopover?.url ?? ''}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
            onContextMenu={(e) => e.currentTarget.select()}
            className="select-all bg-muted font-mono text-xs text-muted-foreground"
            data-testid="share-button-url"
            aria-label={t`Share URL`}
          />
          <div className="absolute inset-y-0 right-1 flex items-center">
            <div className="rounded-md bg-background/50 backdrop-blur-sm">
              <CopyButton
                copyContent={sharePopover?.url ?? ''}
                clipboardWrite={scheduleClipboardWrite}
                initialCopied={sharePopover?.autoCopyFailed === false}
              />
            </div>
          </div>
        </div>
        <a
          href={SHARE_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => dispatchExternalLinkClick(e, SHARE_DOCS_URL)}
          onAuxClick={(e) => dispatchExternalLinkClick(e, SHARE_DOCS_URL)}
          className="mt-2 flex items-center gap-1.5 self-start text-xs text-muted-foreground transition-colors hover:text-primary"
        >
          <CircleHelp aria-hidden="true" className="size-3.5 shrink-0" />
          <Trans>How does sharing work?</Trans>
        </a>
      </PopoverContent>
    </Popover>
  );
}
