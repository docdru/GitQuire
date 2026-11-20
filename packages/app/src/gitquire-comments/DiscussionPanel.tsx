import { formatRelativeAge } from '@gitquire/core/utils/relative-time';
import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Panel,
  PanelBody,
  PanelCount,
  PanelEmpty,
  PanelHeader,
  PanelTitle,
} from '@/components/ui/panel';
import { MentionTextarea } from '@/gitquire-people/MentionTextarea';
import { knownLogins, usePeople } from '@/lib/gitquire/people';
import { cn } from '@/lib/utils';

import { findQuoteRange } from './anchor-search';
import { registerCommentEditor, useCommentEditor } from './comment-editors';
import { type PlacedThread, placeThreads, readThreads } from './editor-threads';
import { type TextRange, useFloatingAnchor } from './floating-anchor';
import {
  type Author,
  addReply,
  canModify,
  compareThreads,
  createThread,
  deleteComment,
  editComment,
  editOutcome,
  hasCommentBody,
  type OpContext,
  segmentMentions,
  setResolved,
  type Thread,
  type ThreadComment,
} from './thread-ops';
import { writeAndTrack } from './thread-sync';
import {
  clearDraft,
  clearReveal,
  currentAuthor,
  setActiveThread,
  showThreadInPane,
  useDiscussionUi,
} from './ui-store';

const QUOTE_CLASS = 'line-clamp-2 border-s-2 ps-2 text-start text-muted-foreground text-xs';
const CARD_CLASS =
  'fixed z-50 flex w-[min(24rem,calc(100vw-1rem))] flex-col gap-3 overflow-y-auto rounded-lg border bg-background p-3 shadow-lg';
const KEEP_CARD_OPEN_SELECTOR =
  '[data-discussion-card], [data-discussion-id], [data-gitquire-comment-mark], [data-comments-panel], [data-testid="discussion-bubble-button"], [data-testid="touch-edit-toolbar"], [data-sonner-toaster]';

const EMPTY: Thread[] = [];

const ignore = (): undefined => undefined;

function useThreads(editor: Editor): Thread[] {
  return useSyncExternalStore(
    (onChange) => {
      editor.on('transaction', onChange);
      return () => {
        editor.off('transaction', onChange);
      };
    },
    () => (editor.isDestroyed ? EMPTY : readThreads(editor.state.doc)),
    () => EMPTY,
  );
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function opContext(): Promise<OpContext> {
  const author = await currentAuthor();
  return { author, now: () => new Date(), newId };
}

type ThreadChange = (threads: Thread[], ctx: OpContext) => Thread[];

async function applyChange(editor: Editor, change: ThreadChange): Promise<void> {
  const ctx = await opContext();
  if (editor.isDestroyed) throw new Error('The editor closed before the comment was saved.');
  writeAndTrack(editor, change(readThreads(editor.state.doc), ctx));
}

function MentionText({ body }: { body: string }) {
  const { t } = useLingui();
  const { loaded, people } = usePeople();
  const known = knownLogins(people);
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {segmentMentions(body).map((segment) => {
        if (!segment.mention) return <span key={segment.start}>{segment.text}</span>;
        const recognised = !loaded || known.has(segment.text.slice(1).toLowerCase());
        return recognised ? (
          <span
            key={segment.start}
            className="rounded bg-primary/10 px-0.5 font-medium text-primary"
            data-mention="known"
          >
            {segment.text}
          </span>
        ) : (
          <span
            key={segment.start}
            className="text-muted-foreground underline decoration-dotted"
            title={t`Nobody with this GitHub username uses this wiki.`}
            data-mention="unknown"
          >
            {segment.text}
          </span>
        );
      })}
    </p>
  );
}

function CommentRow({
  comment,
  me,
  onDelete,
  onEdit,
}: {
  comment: ThreadComment;
  me: Author | null;
  onDelete: () => void;
  onEdit: (body: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const who = comment.author.name ?? comment.author.login ?? comment.author.id;
  const age = formatRelativeAge(comment.createdAt);
  const mine = me !== null && canModify(comment, me);
  const editing = mine && draft !== null;

  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    editButton.current?.focus();
  }, [editing]);

  function close() {
    returnFocus.current = true;
    setDraft(null);
  }

  async function save() {
    if (busy) return;
    const outcome = editOutcome(draft ?? '', comment.body);
    if (outcome.kind === 'empty') return;
    if (outcome.kind === 'unchanged') {
      close();
      return;
    }
    setBusy(true);
    await onEdit(outcome.body).then(close, ignore);
    setBusy(false);
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-2" data-testid="discussion-comment-edit">
        <MentionTextarea
          rows={2}
          value={draft ?? ''}
          autoFocus
          disabled={busy}
          aria-label={t`Comment`}
          onValueChange={setDraft}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || busy) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void save();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={close}>
            {t`Cancel`}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={(draft ?? '').trim() === '' || busy}
            onClick={() => void save()}
          >
            {t`Save`}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col gap-1">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{who}</span>
        <span>{age}</span>
        {comment.editedAt !== undefined && <span>{t`edited`}</span>}
        {mine && (
          <span className="ms-auto flex gap-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              ref={editButton}
              onClick={() => setDraft(comment.body)}
              aria-label={t`Edit this comment`}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onDelete}
              aria-label={t`Delete comment`}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </span>
        )}
      </div>
      <MentionText body={comment.body} />
    </div>
  );
}

function ThreadCard({
  placed,
  active,
  expanded,
  framed = true,
  me,
  onSelect,
  onReply,
  onResolve,
  onDelete,
  onEdit,
}: {
  placed: PlacedThread;
  active: boolean;
  expanded: boolean;
  framed?: boolean;
  me: Author | null;
  onSelect: () => void;
  onReply: (body: string) => Promise<void>;
  onResolve: () => void;
  onDelete: (commentId: string) => void;
  onEdit: (commentId: string, body: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const { thread, range } = placed;
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    const body = reply.trim();
    if (body === '' || busy) return;
    setBusy(true);
    await onReply(body).then(
      () => setReply(''),
      () => undefined,
    );
    setBusy(false);
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-3',
        framed && 'rounded-lg border p-3',
        framed && active && 'border-warning shadow-sm',
      )}
      data-discussion-thread={thread.id}
    >
      <Button
        type="button"
        variant="ghost"
        className={cn(QUOTE_CLASS, 'h-auto justify-start whitespace-normal border-warning')}
        onClick={onSelect}
      >
        {thread.anchor.exact}
      </Button>
      {range === null && (
        <p className="text-destructive text-xs">{t`The quoted text is no longer in the page.`}</p>
      )}
      <div className="flex flex-col gap-3">
        {thread.comments.map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            me={me}
            onDelete={() => onDelete(comment.id)}
            onEdit={(body) => onEdit(comment.id, body)}
          />
        ))}
      </div>
      {expanded && (
        <div className="flex flex-col gap-2">
          <MentionTextarea
            rows={2}
            value={reply}
            placeholder={t`Write a reply. Type @ to mention someone.`}
            aria-label={t`Reply`}
            onValueChange={setReply}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onResolve}>
              <Check aria-hidden="true" />
              {t`Resolve`}
            </Button>
            <Button type="button" size="sm" disabled={reply.trim() === '' || busy} onClick={send}>
              {t`Reply`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AnchoredCard({
  editor,
  range,
  label,
  onClose,
  onDismiss,
  children,
}: {
  editor: Editor;
  range: TextRange;
  label: string;
  onClose: () => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const card = useRef<HTMLElement>(null);
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
  });
  useFloatingAnchor(editor, range, card);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(KEEP_CARD_OPEN_SELECTOR) !== null) return;
      dismiss.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Node) || card.current?.contains(target) !== true) return;
      event.preventDefault();
      dismiss.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return createPortal(
    <section
      ref={card}
      className={CARD_CLASS}
      style={{ left: 0, top: 0, visibility: 'hidden' }}
      aria-label={label}
      data-discussion-card=""
      data-testid="discussion-card"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute end-2 top-2"
        onClick={onClose}
        aria-label={t`Close comment`}
      >
        <X aria-hidden="true" />
      </Button>
      {children}
    </section>,
    document.body,
  );
}

function useMe(needed: boolean): Author | null {
  const [me, setMe] = useState<Author | null>(null);
  useEffect(() => {
    if (!needed || me !== null) return;
    let live = true;
    currentAuthor().then((author) => {
      if (live) setMe(author);
    }, ignore);
    return () => {
      live = false;
    };
  }, [needed, me]);
  return me;
}

function useThreadActions(editor: Editor) {
  const { t } = useLingui();

  function run(change: ThreadChange): Promise<void> {
    return applyChange(editor, change).catch((err: unknown) => {
      toast.error(t`Couldn't save the comment.`);
      throw err;
    });
  }

  return {
    replyTo(threadId: string, body: string): Promise<void> {
      return run((current, ctx) => addReply(current, threadId, body, ctx));
    },
    resolve(threadId: string): void {
      run((current) => setResolved(current, threadId, true))
        .then(() => setActiveThread(null))
        .catch(ignore);
    },
    remove(threadId: string, commentId: string): void {
      run((current, ctx) => deleteComment(current, threadId, commentId, ctx.author)).catch(ignore);
    },
    edit(threadId: string, commentId: string, body: string): Promise<void> {
      return run((current, ctx) => {
        const next = editComment(current, threadId, commentId, body, ctx);
        if (!hasCommentBody(next, threadId, commentId, body)) {
          throw new Error('The comment is no longer there to edit.');
        }
        return next;
      });
    },
  };
}

function placedThreads(editor: Editor, threads: Thread[]): PlacedThread[] {
  return placeThreads(editor.state.doc, [...threads].sort(compareThreads));
}

export function DiscussionPanel({ editor, docName }: { editor: Editor; docName: string }) {
  const { t } = useLingui();
  const ui = useDiscussionUi();
  const threads = useThreads(editor);
  const actions = useThreadActions(editor);
  const [draftBody, setDraftBody] = useState('');

  useEffect(() => registerCommentEditor(docName, editor), [docName, editor]);

  const forThisDoc = ui.docName === docName;
  const draft = forThisDoc ? ui.draft : null;
  const activeThreadId = forThisDoc ? ui.activeThreadId : null;
  const activePlaced =
    activeThreadId === null
      ? null
      : (placedThreads(editor, threads).find((p) => p.thread.id === activeThreadId) ?? null);
  const activeRange = activePlaced?.range ?? null;
  const me = useMe(draft !== null || activePlaced !== null);
  const orphanThreadId = activePlaced !== null && activeRange === null ? activePlaced.thread.id : null;

  useEffect(() => {
    if (orphanThreadId !== null) showThreadInPane(docName, orphanThreadId);
  }, [orphanThreadId, docName]);

  const revealThreadId = forThisDoc ? ui.revealThreadId : null;
  const revealReady =
    revealThreadId !== null && threads.some((thread) => thread.id === revealThreadId);

  useEffect(() => {
    if (!revealReady || revealThreadId === null || editor.isDestroyed) return;
    const target = threads.filter((thread) => thread.id === revealThreadId);
    const range = placeThreads(editor.state.doc, target)[0]?.range ?? null;
    if (range !== null) editor.chain().setTextSelection(range).scrollIntoView().run();
    clearReveal();
  }, [editor, revealReady, revealThreadId, threads]);

  async function createFromDraft() {
    const body = draftBody.trim();
    if (draft === null || body === '') return;
    let ctx: OpContext;
    try {
      ctx = await opContext();
    } catch {
      toast.error(t`Couldn't save the comment.`);
      return;
    }
    const created = createThread(readThreads(editor.state.doc), draft.anchor, body, ctx);
    const range = findQuoteRange(editor.state.doc, draft.anchor.exact, {
      prefix: draft.anchor.prefix,
      suffix: draft.anchor.suffix,
    });
    const mark = range === null ? undefined : { id: created.thread.id, pos: range.to };
    if (!writeAndTrack(editor, created.threads, mark)) return;
    setDraftBody('');
    clearDraft();
    setActiveThread(created.thread.id);
  }

  function cancelDraft() {
    setDraftBody('');
    clearDraft();
  }

  const draftCard = draft !== null && (
    <AnchoredCard
      editor={editor}
      range={draft}
      label={t`New comment`}
      onClose={cancelDraft}
      onDismiss={() => {
        if (draftBody.trim() === '') cancelDraft();
      }}
    >
      <p className={cn(QUOTE_CLASS, 'me-6 border-info')}>{draft.anchor.exact}</p>
      <MentionTextarea
        rows={3}
        value={draftBody}
        placeholder={t`Add a comment. Type @ to mention someone.`}
        aria-label={t`Comment`}
        autoFocus
        onValueChange={setDraftBody}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void createFromDraft();
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={cancelDraft}>
          {t`Cancel`}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={draftBody.trim() === ''}
          onClick={() => void createFromDraft()}
        >
          {t`Comment`}
        </Button>
      </div>
    </AnchoredCard>
  );

  const threadPopover = draft === null && activePlaced !== null && activeRange !== null && (
    <AnchoredCard
      key={activePlaced.thread.id}
      editor={editor}
      range={activeRange}
      label={t`Comment thread`}
      onClose={() => setActiveThread(null)}
      onDismiss={() => setActiveThread(null)}
    >
      <div className="me-6">
        <ThreadCard
          placed={activePlaced}
          active
          expanded
          framed={false}
          me={me}
          onSelect={() => {
            editor.chain().setTextSelection(activeRange).scrollIntoView().run();
          }}
          onReply={(body) => actions.replyTo(activePlaced.thread.id, body)}
          onResolve={() => actions.resolve(activePlaced.thread.id)}
          onDelete={(commentId) => actions.remove(activePlaced.thread.id, commentId)}
          onEdit={(commentId, body) => actions.edit(activePlaced.thread.id, commentId, body)}
        />
      </div>
    </AnchoredCard>
  );

  return (
    <>
      {draftCard}
      {threadPopover}
    </>
  );
}

export function useOpenThreadCount(docName: string): number {
  const editor = useCommentEditor(docName);
  return useSyncExternalStore(
    (onChange) => {
      if (editor === null) return ignore;
      editor.on('transaction', onChange);
      return () => {
        editor.off('transaction', onChange);
      };
    },
    () => (editor === null || editor.isDestroyed ? 0 : readThreads(editor.state.doc).length),
    () => 0,
  );
}

function CommentList({
  editor,
  docName,
  onNavigated,
}: {
  editor: Editor;
  docName: string;
  onNavigated?: (target?: HTMLElement) => void;
}) {
  const { t } = useLingui();
  const ui = useDiscussionUi();
  const threads = useThreads(editor);
  const actions = useThreadActions(editor);
  const me = useMe(true);
  const placed = placedThreads(editor, threads);
  const activeThreadId = ui.docName === docName ? ui.activeThreadId : null;

  function select(p: PlacedThread) {
    if (p.range === null || editor.isDestroyed) {
      setActiveThread(p.thread.id);
      return;
    }
    editor.chain().setTextSelection(p.range).scrollIntoView().run();
    showThreadInPane(docName, p.thread.id);
    onNavigated?.(editor.view.dom);
  }

  if (placed.length === 0) {
    return (
      <PanelEmpty className="px-2">
        {t`Select text and choose Comment to start a thread. Comments are saved in the page.`}
      </PanelEmpty>
    );
  }

  return (
    <ul className="flex flex-col gap-3" aria-label={t`Comment threads`}>
      {placed.map((p) => {
        const active = activeThreadId === p.thread.id;
        return (
          <li key={p.thread.id}>
            <ThreadCard
              placed={p}
              active={active}
              expanded={active && p.range === null}
              me={me}
              onSelect={() => select(p)}
              onReply={(body) => actions.replyTo(p.thread.id, body)}
              onResolve={() => actions.resolve(p.thread.id)}
              onDelete={(commentId) => actions.remove(p.thread.id, commentId)}
              onEdit={(commentId, body) => actions.edit(p.thread.id, commentId, body)}
            />
          </li>
        );
      })}
    </ul>
  );
}

export function CommentsPanel({
  docName,
  onNavigated,
}: {
  docName: string;
  onNavigated?: (target?: HTMLElement) => void;
}) {
  const { t } = useLingui();
  const editor = useCommentEditor(docName);
  const count = useOpenThreadCount(docName);
  return (
    <Panel data-comments-panel="">
      <PanelHeader>
        <div className="flex min-w-0 items-center gap-2">
          <PanelTitle>{t`Comments`}</PanelTitle>
          {editor !== null && <PanelCount>{count}</PanelCount>}
        </div>
      </PanelHeader>
      <PanelBody className="px-3 py-2">
        {editor === null ? (
          <PanelEmpty className="px-2">
            {t`Comments are shown when the page is open in the editor.`}
          </PanelEmpty>
        ) : (
          <CommentList editor={editor} docName={docName} onNavigated={onNavigated} />
        )}
      </PanelBody>
    </Panel>
  );
}
