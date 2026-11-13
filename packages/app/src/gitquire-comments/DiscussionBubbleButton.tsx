import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { MessageSquarePlus } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatShortcut,
  formatShortcutLabel,
  matchesKeyboardShortcut,
} from '@/lib/keyboard-shortcuts';
import { useEditorPaneOnScreen } from '@/lib/use-editor-pane-on-screen';
import { anchorFromSelection } from './editor-threads';
import { startDraft } from './ui-store';

function startCommentOnSelection(editor: Editor, docName: string): boolean {
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;
  const anchor = anchorFromSelection(editor.state.doc, from, to);
  if (anchor === undefined) return false;
  startDraft(docName, { anchor, from, to });
  return true;
}

export function CommentShortcut({
  editor,
  docName,
  enabled,
}: {
  editor: Editor;
  docName: string;
  enabled: boolean;
}) {
  const editorPaneOnScreen = useEditorPaneOnScreen();

  useEffect(() => {
    if (!enabled || !editorPaneOnScreen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!matchesKeyboardShortcut(event, 'add-comment')) return;
      const target = event.target;
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (startCommentOnSelection(editor, docName)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, editorPaneOnScreen, editor, docName]);

  return null;
}

export function DiscussionBubbleButton({ editor, docName }: { editor: Editor; docName: string }) {
  const { t } = useLingui();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="discussion-bubble-button"
          className="gap-1 px-2 text-sm font-medium text-accent-foreground/80"
          onClick={() => startCommentOnSelection(editor, docName)}
        >
          <MessageSquarePlus className="size-3.5" aria-hidden="true" />
          <span>{t`Comment`}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8} className="flex items-center gap-2">
        {t`Comment on this selection`}
        <Kbd aria-label={formatShortcutLabel('add-comment')}>{formatShortcut('add-comment')}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
