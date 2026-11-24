import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { AtSign, Bell, ListChecks, MessageSquarePlus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { anchorFromSelection } from '@/gitquire-comments/editor-threads';
import { UNPLACED_STYLE, useFloatingAnchor } from '@/gitquire-comments/floating-anchor';
import { startDraft } from '@/gitquire-comments/ui-store';
import { knownLogins, type Person, usePeople } from '@/lib/gitquire/people';
import {
  claimPageMentionReveal,
  openMentionPanel,
  subscribePageMentionReveal,
} from './mention-events';
import { findPageMention, type MentionRange, mentionAt } from './page-mention-find';
import { flashRange } from './people-mention';

const HOVER_DELAY_MS = 400;
const LEAVE_DELAY_MS = 300;
const CARD_CLASS =
  'fixed z-50 flex w-[min(20rem,calc(100vw-1rem))] flex-col gap-2 rounded-lg border bg-background p-3 shadow-lg';

type Opened = { range: MentionRange; by: 'pointer' | 'hover' | 'caret' };

function listItemDepth(editor: Editor, pos: number): number | undefined {
  const $pos = editor.state.doc.resolve(pos);
  if ($pos.depth < 2) return undefined;
  return $pos.node($pos.depth - 1).type.name === 'listItem' ? $pos.depth - 1 : undefined;
}

function inTableCell(editor: Editor, pos: number): boolean {
  const $pos = editor.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const name = $pos.node(depth).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return true;
  }
  return false;
}

export function canMakeActionItem(editor: Editor, range: MentionRange): boolean {
  return (
    range.place === 'page' &&
    range.block.type.name === 'paragraph' &&
    !inTableCell(editor, range.from)
  );
}

export function makeActionItem(editor: Editor, range: MentionRange): boolean {
  if (!canMakeActionItem(editor, range)) return false;
  const itemDepth = listItemDepth(editor, range.from);
  if (itemDepth === undefined) {
    return editor.chain().focus().setTextSelection(range.from).toggleTaskList().run();
  }
  const $pos = editor.state.doc.resolve(range.from);
  const item = $pos.node(itemDepth);
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup($pos.before(itemDepth), undefined, {
      ...item.attrs,
      checked: false,
    }),
  );
  editor.commands.focus();
  return true;
}

export function commentTo(editor: Editor, docName: string, range: MentionRange): boolean {
  const anchor = anchorFromSelection(editor.state.doc, range.from, range.to);
  if (anchor === undefined) return false;
  startDraft(docName, { anchor, from: range.from, to: range.to, body: `@${range.login} ` });
  return true;
}

function PersonLine({ login, person }: { login: string; person: Person | undefined }) {
  const name = person?.name ?? login;
  return (
    <div className="flex items-center gap-2 pe-6">
      {person?.avatarUrl === undefined ? (
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-sm"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
      ) : (
        <img
          src={person.avatarUrl}
          alt=""
          className="size-7 shrink-0 rounded-full"
          referrerPolicy="no-referrer"
        />
      )}
      <div className="min-w-0">
        <p className="truncate font-medium text-sm">{name}</p>
        <p className="truncate text-muted-foreground text-xs">@{login}</p>
      </div>
    </div>
  );
}

export function PageMentionCard({
  editor,
  docName,
  range,
  focusOnOpen,
  onClose,
}: {
  editor: Editor;
  docName: string;
  range: MentionRange;
  focusOnOpen: boolean;
  onClose: (returnFocus: boolean) => void;
}) {
  const { t } = useLingui();
  const card = useRef<HTMLElement>(null);
  const { people } = usePeople();
  const person = people.find((candidate) => candidate.login.toLowerCase() === range.login);
  useFloatingAnchor(editor, range, card);

  useEffect(() => {
    if (focusOnOpen) card.current?.querySelector<HTMLElement>('button[data-first]')?.focus();
  }, [focusOnOpen]);

  const login = range.login;
  const notifies = range.place === 'action-item';

  return createPortal(
    <section
      ref={card}
      role="dialog"
      aria-label={t`Mention of @${login}`}
      className={CARD_CLASS}
      style={UNPLACED_STYLE}
      data-page-mention-card=""
      data-testid="page-mention-card"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose(true);
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute end-2 top-2"
        onClick={() => onClose(true)}
        aria-label={t`Close`}
      >
        <X aria-hidden="true" />
      </Button>
      <PersonLine login={login} person={person} />
      <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        {notifies ? (
          <>
            <Bell aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            {t`This action item notifies @${login}.`}
          </>
        ) : (
          t`A mention in the page text does not notify @${login}.`
        )}
      </p>
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start gap-2"
          data-first=""
          data-testid="page-mention-comment"
          onClick={() => {
            onClose(false);
            if (!commentTo(editor, docName, range)) toast.error(t`Couldn't start a comment here.`);
          }}
        >
          <MessageSquarePlus aria-hidden="true" />
          {t`Comment to @${login}`}
        </Button>
        {canMakeActionItem(editor, range) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto justify-start gap-2 whitespace-normal py-1.5 text-start"
            data-testid="page-mention-action-item"
            onClick={() => {
              onClose(false);
              if (!makeActionItem(editor, range)) {
                toast.error(t`Couldn't turn this line into an action item.`);
              }
            }}
          >
            <ListChecks aria-hidden="true" />
            <span className="flex flex-col">
              <span>{t`Make it an action item`}</span>
              <span className="text-muted-foreground text-xs">
                {t`Changes the page: this line becomes an action item for @${login}.`}
              </span>
            </span>
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start gap-2"
          data-testid="page-mention-all"
          onClick={() => {
            onClose(false);
            openMentionPanel({ tab: 'pages', login });
          }}
        >
          <AtSign aria-hidden="true" />
          {t`All mentions of @${login}`}
        </Button>
      </div>
    </section>,
    document.body,
  );
}

function mentionElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? (target.closest<HTMLElement>('[data-gq-mention]') ?? null)
    : null;
}

export function PageMentionLayer({ editor, docName }: { editor: Editor; docName: string }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const openedRef = useRef<Opened | null>(null);
  const { people } = usePeople();
  const known = knownLogins(people);
  const knownRef = useRef(known);
  useLayoutEffect(() => {
    openedRef.current = opened;
    knownRef.current = known;
  });

  useEffect(() => {
    const dom = editor.view.dom;
    let hoverTimer: number | undefined;
    let leaveTimer: number | undefined;

    function rangeFor(element: HTMLElement): MentionRange | undefined {
      if (editor.isDestroyed) return undefined;
      const pos = editor.view.posAtDOM(element, 0);
      return mentionAt(editor.state.doc, pos);
    }

    const onClick = (event: MouseEvent): void => {
      const element = mentionElement(event.target);
      if (element === null) return;
      const range = rangeFor(element);
      if (range !== undefined) setOpened({ range, by: 'pointer' });
    };
    const onOver = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return;
      const element = mentionElement(event.target);
      window.clearTimeout(leaveTimer);
      if (element === null) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => {
        const range = rangeFor(element);
        if (range !== undefined && openedRef.current?.by !== 'pointer') {
          setOpened({ range, by: 'hover' });
        }
      }, HOVER_DELAY_MS);
    };
    const onOut = (event: PointerEvent): void => {
      if (mentionElement(event.target) === null) return;
      window.clearTimeout(hoverTimer);
      leaveTimer = window.setTimeout(() => {
        const card = document.querySelector('[data-page-mention-card]');
        if (openedRef.current?.by === 'hover' && card?.matches(':hover') !== true) setOpened(null);
      }, LEAVE_DELAY_MS);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && event.altKey) {
        const { from, empty } = editor.state.selection;
        const range = empty ? mentionAt(editor.state.doc, from) : undefined;
        if (range === undefined || !knownRef.current.has(range.login)) return;
        event.preventDefault();
        setOpened({ range, by: 'caret' });
      }
    };
    dom.addEventListener('click', onClick);
    dom.addEventListener('pointerover', onOver);
    dom.addEventListener('pointerout', onOut);
    dom.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(hoverTimer);
      window.clearTimeout(leaveTimer);
      dom.removeEventListener('click', onClick);
      dom.removeEventListener('pointerover', onOver);
      dom.removeEventListener('pointerout', onOut);
      dom.removeEventListener('keydown', onKeyDown);
    };
  }, [editor]);

  useEffect(() => {
    if (opened === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-page-mention-card]') !== null) return;
      if (mentionElement(target) !== null) return;
      setOpened(null);
    };
    const onUpdate = ({ transaction }: { transaction: { docChanged: boolean } }): void => {
      if (transaction.docChanged) setOpened(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    editor.on('transaction', onUpdate);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      editor.off('transaction', onUpdate);
    };
  }, [editor, opened]);

  useEffect(() => {
    function tryReveal(): void {
      if (editor.isDestroyed) return;
      claimPageMentionReveal(docName, (target) => {
        const range = findPageMention(editor.state.doc, target);
        if (range === undefined) return false;
        editor.chain().setTextSelection(range.from).scrollIntoView().run();
        flashRange(editor.view, range.from, range.to);
        return true;
      });
    }
    const later = (): void => {
      window.setTimeout(tryReveal, 0);
    };
    const unsubscribe = subscribePageMentionReveal(later);
    const ready = window.setTimeout(tryReveal, 0);
    editor.on('update', later);
    return () => {
      unsubscribe();
      window.clearTimeout(ready);
      editor.off('update', later);
    };
  }, [editor, docName]);

  if (opened === null) return null;
  return (
    <PageMentionCard
      key={`${opened.range.from}:${opened.range.login}`}
      editor={editor}
      docName={docName}
      range={opened.range}
      focusOnOpen={opened.by === 'caret'}
      onClose={(returnFocus) => {
        setOpened(null);
        if (returnFocus && !editor.isDestroyed) editor.commands.focus();
      }}
    />
  );
}
