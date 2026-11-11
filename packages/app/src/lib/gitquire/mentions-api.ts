import { type ApiDeps, gitquireRequest } from './branch-api';

export interface MentionAuthor {
  id: string;
  login?: string;
  name?: string;
}

export interface InboxMention {
  id: string;
  path: string;
  docName: string;
  threadId: string;
  commentId: string;
  author: MentionAuthor;
  at: string;
  body: string;
  quote: string;
  resolved: boolean;
  read: boolean;
}

export interface MentionInboxData {
  enabled: boolean;
  login: string | null;
  unread: number;
  mentions: InboxMention[];
}

export type ReadTarget = { ids: string[] } | { all: true };

export function fetchMentions(deps: ApiDeps = {}): Promise<MentionInboxData> {
  return gitquireRequest('/api/gitquire/mentions', {}, deps);
}

export function markMentionsRead(
  target: ReadTarget,
  deps: ApiDeps = {},
): Promise<{ unread: number }> {
  return gitquireRequest('/api/gitquire/mentions/read', { method: 'POST', body: target }, deps);
}

export function withMentionsRead(inbox: MentionInboxData, target: ReadTarget): MentionInboxData {
  const ids = 'all' in target ? undefined : new Set(target.ids);
  const mentions = inbox.mentions.map((mention) =>
    mention.read || (ids !== undefined && !ids.has(mention.id))
      ? mention
      : { ...mention, read: true },
  );
  if (ids === undefined) return { ...inbox, mentions, unread: 0 };
  const newlyRead = mentions.filter((mention, index) => mention !== inbox.mentions[index]).length;
  return { ...inbox, mentions, unread: Math.max(0, inbox.unread - newlyRead) };
}

export function pageTitle(docName: string): string {
  return docName.slice(docName.lastIndexOf('/') + 1);
}

export function unreadBadge(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}
