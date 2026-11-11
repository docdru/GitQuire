import { formatRelativeAge } from '@inkeep/open-knowledge-core/utils/relative-time';
import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { Check, MessagesSquare, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { type PlacedThread, placeThreads, readThreads, writeThreads } from './editor-threads';
import {
  type Author,
  addReply,
  canModify,
  compareThreads,
  createThread,
  deleteComment,
  type OpContext,
  segmentMentions,
  setResolved,
  type Thread,
  type ThreadComment,
} from './thread-ops';
import {
  clearDraft,
  closeDiscussions,
  currentAuthor,
  openDiscussions,
  setActiveThread,
  useDiscussionUi,
} from './ui-store';

const QUOTE_CLASS = 'line-clamp-2 border-s-2 ps-2 text-start text-muted-foreground text-xs';
const PANEL_CLASS =
  'fixed end-0 top-12 bottom-0 z-40 flex w-full flex-col border-s bg-background shadow-lg sm:w-96';

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

function commit(editor: Editor, threads: readonly Thread[]): boolean {
  if (editor.isDestroyed) return false;
  const tr = writeThreads(editor.state, threads);
  if (tr === undefined) return false;
  editor.view.dispatch(tr);
  return true;
}

function MentionText({ body }: { body: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {segmentMentions(body).map((segment) =>
        segment.mention ? (
          <span key={segment.start} className="font-medium text-primary">
            {segment.text}
          </span>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

function CommentRow({
  comment,
  me,
  onDelete,
}: {
  comment: ThreadComment;
  me: Author | null;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const who = comment.author.name ?? comment.author.login ?? comment.author.id;
  const age = formatRelativeAge(comment.createdAt);
  return (
    <div className="group flex flex-col gap-1">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{who}</span>
        <span>{age}</span>
        {comment.editedAt !== undefined && <span>{t`edited`}</span>}
        {me !== null && canModify(comment, me) && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ms-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onDelete}
            aria-label={t`Delete comment`}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        )}
      </div>
      <MentionText body={comment.body} />
    </div>
  );
}

function ThreadCard({
  placed,
  active,
  me,
  onSelect,
  onReply,
  onResolve,
  onDelete,
}: {
  placed: PlacedThread;
  active: boolean;
  me: Author | null;
  onSelect: () => void;
  onReply: (body: string) => Promise<void>;
  onResolve: (resolved: boolean) => void;
  onDelete: (commentId: string) => void;
}) {
  const { t } = useLingui();
  const { thread, range } = placed;
  const resolvedBy = thread.resolvedBy;
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
    <li
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-3',
        active && 'border-warning shadow-sm',
        thread.resolved && 'opacity-70',
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
          />
        ))}
      </div>
      {thread.resolved && resolvedBy !== undefined && (
        <p className="text-muted-foreground text-xs">{t`Resolved by ${resolvedBy}`}</p>
      )}
      {active && (
        <div className="flex flex-col gap-2">
          <Textarea
            rows={2}
            value={reply}
            placeholder={t`Write a reply. Use @name to mention someone.`}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onResolve(!thread.resolved)}
            >
              {thread.resolved ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
              {thread.resolved ? t`Reopen` : t`Resolve`}
            </Button>
            <Button type="button" size="sm" disabled={reply.trim() === '' || busy} onClick={send}>
              {t`Reply`}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function DiscussionPanel({ editor, docName }: { editor: Editor; docName: string }) {
  const { t } = useLingui();
  const ui = useDiscussionUi();
  const threads = useThreads(editor);
  const [me, setMe] = useState<Author | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  const isOpen = ui.open && ui.docName === docName;
  const openCount = threads.filter((thread) => !thread.resolved).length;

  useEffect(() => {
    if (!isOpen || me !== null) return;
    let live = true;
    currentAuthor().then((author) => {
      if (live) setMe(author);
    }, ignore);
    return () => {
      live = false;
    };
  }, [isOpen, me]);

  async function run(change: (threads: Thread[], ctx: OpContext) => Thread[]): Promise<void> {
    try {
      const ctx = await opContext();
      commit(editor, change(readThreads(editor.state.doc), ctx));
    } catch (err) {
      toast.error(t`Couldn't save the comment.`);
      throw err;
    }
  }

  async function createFromDraft() {
    const draft = ui.draft;
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
    if (!commit(editor, created.threads)) return;
    setDraftBody('');
    clearDraft();
    setActiveThread(created.thread.id);
  }

  function replyTo(threadId: string, body: string): Promise<void> {
    return run((current, ctx) => addReply(current, threadId, body, ctx));
  }

  function resolve(threadId: string, resolved: boolean) {
    run((current, ctx) => setResolved(current, threadId, resolved, ctx)).catch(ignore);
  }

  function remove(threadId: string, commentId: string) {
    run((current, ctx) => deleteComment(current, threadId, commentId, ctx.author)).catch(ignore);
  }

  function select(placed: PlacedThread) {
    setActiveThread(placed.thread.id);
    if (placed.range === null || editor.isDestroyed) return;
    editor.chain().setTextSelection(placed.range).scrollIntoView().run();
  }

  if (!isOpen) {
    if (openCount === 0) return null;
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="fixed end-4 bottom-4 z-40 gap-1.5 shadow-md"
        onClick={() => openDiscussions(docName)}
        data-testid="discussion-toggle"
      >
        <MessagesSquare aria-hidden="true" />
        {t`Discussions`}
        <span className="rounded-full bg-warning/20 px-1.5 text-xs tabular-nums">{openCount}</span>
      </Button>
    );
  }

  const placed = placeThreads(editor.state.doc, [...threads].sort(compareThreads));
  const visible = placed.filter((p) => showResolved || !p.thread.resolved);
  const resolvedCount = threads.length - openCount;

  return (
    <aside className={PANEL_CLASS} aria-label={t`Discussions`} data-testid="discussion-panel">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <MessagesSquare aria-hidden="true" className="size-4" />
        <h2 className="font-medium text-sm">{t`Discussions`}</h2>
        <span className="text-muted-foreground text-xs">{openCount}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ms-auto"
          onClick={closeDiscussions}
          aria-label={t`Close discussions`}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {ui.draft !== null && (
          <div className="flex flex-col gap-2 rounded-lg border border-info/40 p-3">
            <p className={cn(QUOTE_CLASS, 'border-info')}>{ui.draft.anchor.exact}</p>
            <Textarea
              rows={3}
              value={draftBody}
              placeholder={t`Add a comment. Use @name to mention someone.`}
              onChange={(e) => setDraftBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void createFromDraft();
              }}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={clearDraft}>
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
          </div>
        )}
        {visible.length === 0 && ui.draft === null && (
          <p className="text-muted-foreground text-sm">
            {t`Select text and choose Discuss to start a thread. Comments are saved in the page.`}
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {visible.map((p) => (
            <ThreadCard
              key={p.thread.id}
              placed={p}
              active={ui.activeThreadId === p.thread.id}
              me={me}
              onSelect={() => select(p)}
              onReply={(body) => replyTo(p.thread.id, body)}
              onResolve={(resolved) => resolve(p.thread.id, resolved)}
              onDelete={(commentId) => remove(p.thread.id, commentId)}
            />
          ))}
        </ul>
        {resolvedCount > 0 && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="self-start"
            onClick={() => setShowResolved(!showResolved)}
          >
            {showResolved ? t`Hide resolved` : t`Show resolved (${resolvedCount})`}
          </Button>
        )}
      </div>
    </aside>
  );
}
