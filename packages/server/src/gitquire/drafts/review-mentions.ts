import type { Mention } from '../mentions.ts';
import type { DraftRecord } from './model.ts';

export function reviewMentionsOf(drafts: readonly DraftRecord[], idPrefix: string): Mention[] {
  const out: Mention[] = [];
  for (const draft of drafts) {
    if (draft.status !== 'review') continue;
    for (const request of draft.requests) {
      if (request.logins.length === 0) continue;
      out.push({
        id: `draft:${draft.slug}:${request.id}`,
        path: '',
        docName: draft.title,
        threadId: '',
        commentId: request.id,
        author: {
          id: `${idPrefix}${request.by.id}`,
          login: request.by.login,
          ...(request.by.name ? { name: request.by.name } : {}),
        },
        at: request.at,
        body: request.note,
        quote: draft.title,
        resolved: false,
        logins: request.logins,
        draft: { slug: draft.slug, title: draft.title },
      });
    }
  }
  return out;
}
