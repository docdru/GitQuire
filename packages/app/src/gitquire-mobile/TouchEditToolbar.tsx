import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import {
  Bold,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Heading,
  Italic,
  Link2,
  List,
  ListTodo,
  type LucideIcon,
  MessageSquarePlus,
  Redo2,
  Undo2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { anchorFromSelection } from '@/gitquire-comments/editor-threads';
import { startDraft } from '@/gitquire-comments/ui-store';
import { useCoarsePointer, useKeyboardInset } from './viewport';

interface ToolbarAction {
  key: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  active?: boolean;
  disabled?: boolean;
}

const TOOLBAR_CLASS =
  'fixed inset-x-0 z-50 flex items-center gap-0.5 overflow-x-auto border-t bg-background/95 px-1 py-1 shadow-md backdrop-blur';

type HistoryCommands = { undo?: () => boolean; redo?: () => boolean };

function useEditorFocused(editor: Editor): boolean {
  const [focused, setFocused] = useState(() => editor.isFocused);
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    editor.on('focus', onFocus);
    editor.on('blur', onBlur);
    return () => {
      editor.off('focus', onFocus);
      editor.off('blur', onBlur);
    };
  }, [editor]);
  return focused;
}

export function TouchEditToolbar({ editor, docName }: { editor: Editor; docName: string }) {
  const { t } = useLingui();
  const coarse = useCoarsePointer();
  const focused = useEditorFocused(editor);
  const inset = useKeyboardInset();
  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      bold: ctx.editor.isActive('strong'),
      italic: ctx.editor.isActive('emphasis'),
      heading: ctx.editor.isActive('heading'),
      inList: ctx.editor.isActive('listItem'),
      hasSelection: !ctx.editor.state.selection.empty,
    }),
  });

  if (!coarse || !focused || editor.isDestroyed) return null;

  const chain = () => editor.chain().focus();
  const history = editor.commands as unknown as HistoryCommands;

  const actions: ToolbarAction[] = [
    { key: 'undo', label: t`Undo`, icon: Undo2, run: () => history.undo?.() },
    { key: 'redo', label: t`Redo`, icon: Redo2, run: () => history.redo?.() },
    {
      key: 'heading',
      label: t`Heading`,
      icon: Heading,
      active: state.heading,
      run: () => chain().toggleHeading({ level: 2 }).run(),
    },
    {
      key: 'bold',
      label: t`Bold`,
      icon: Bold,
      active: state.bold,
      run: () => chain().toggleBold().run(),
    },
    {
      key: 'italic',
      label: t`Italic`,
      icon: Italic,
      active: state.italic,
      run: () => chain().toggleItalic().run(),
    },
    {
      key: 'bullets',
      label: t`Bulleted list`,
      icon: List,
      run: () => chain().toggleBulletList().run(),
    },
    {
      key: 'tasks',
      label: t`Task list`,
      icon: ListTodo,
      run: () => chain().toggleTaskList().run(),
    },
    {
      key: 'outdent',
      label: t`Outdent`,
      icon: ChevronsLeft,
      disabled: !state.inList,
      run: () => chain().liftListItem('listItem').run(),
    },
    {
      key: 'indent',
      label: t`Indent`,
      icon: ChevronsRight,
      disabled: !state.inList,
      run: () => chain().sinkListItem('listItem').run(),
    },
    {
      key: 'link',
      label: t`Link to a page`,
      icon: Link2,
      run: () => chain().insertContent('[[').run(),
    },
    {
      key: 'discuss',
      label: t`Discuss`,
      icon: MessageSquarePlus,
      disabled: !state.hasSelection,
      run: () => {
        const { from, to } = editor.state.selection;
        const anchor = anchorFromSelection(editor.state.doc, from, to);
        if (anchor !== undefined) startDraft(docName, { anchor, from, to });
      },
    },
  ];

  return (
    <div
      role="toolbar"
      aria-label={t`Formatting`}
      data-testid="touch-edit-toolbar"
      className={TOOLBAR_CLASS}
      style={{ bottom: inset }}
      onPointerDown={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <Button
          key={action.key}
          type="button"
          variant={action.active ? 'secondary' : 'ghost'}
          size="icon"
          className="shrink-0"
          aria-label={action.label}
          aria-pressed={action.active}
          disabled={action.disabled}
          onClick={action.run}
        >
          <action.icon aria-hidden="true" />
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="ms-auto shrink-0"
        aria-label={t`Hide keyboard`}
        onClick={() => editor.commands.blur()}
      >
        <ChevronDown aria-hidden="true" />
      </Button>
    </div>
  );
}
