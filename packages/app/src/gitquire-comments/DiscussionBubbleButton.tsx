import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { anchorFromSelection } from './editor-threads';
import { startDraft } from './ui-store';

export function DiscussionBubbleButton({ editor, docName }: { editor: Editor; docName: string }) {
  const { t } = useLingui();

  function start() {
    const { from, to } = editor.state.selection;
    const anchor = anchorFromSelection(editor.state.doc, from, to);
    if (anchor === undefined) return;
    startDraft(docName, { anchor, from, to });
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="discussion-bubble-button"
          className="gap-1 px-2 text-sm font-medium text-accent-foreground/80"
          onClick={start}
        >
          <MessageSquarePlus className="size-3.5" aria-hidden="true" />
          <span>{t`Discuss`}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        {t`Start a discussion with your team on this selection`}
      </TooltipContent>
    </Tooltip>
  );
}
