import { type ApiDeps, gitquireRequest } from './branch-api';

export interface PageMention {
  id: string;
  path: string;
  docName: string;
  login: string;
  heading: string;
  snippet: string;
  occurrence: number;
  line: number;
}

export interface PageMentionList {
  mentions: PageMention[];
  truncated: boolean;
}

export interface PageMentionGroup {
  docName: string;
  mentions: PageMention[];
}

export const ANYONE = '';

export function fetchPageMentions(login?: string, deps: ApiDeps = {}): Promise<PageMentionList> {
  const query = login === undefined || login === '' ? '' : `?login=${encodeURIComponent(login)}`;
  return gitquireRequest(`/api/gitquire/page-mentions${query}`, {}, deps);
}

export function onlyKnown(
  mentions: readonly PageMention[],
  known: ReadonlySet<string> | undefined,
): PageMention[] {
  if (known === undefined || known.size === 0) return [...mentions];
  return mentions.filter((mention) => known.has(mention.login));
}

export function mentionsOfPerson(mentions: readonly PageMention[], login: string): PageMention[] {
  const wanted = login.toLowerCase();
  if (wanted === ANYONE) return [...mentions];
  return mentions.filter((mention) => mention.login === wanted);
}

export function groupByPage(mentions: readonly PageMention[]): PageMentionGroup[] {
  const groups = new Map<string, PageMention[]>();
  for (const mention of mentions) {
    const list = groups.get(mention.docName);
    if (list === undefined) groups.set(mention.docName, [mention]);
    else list.push(mention);
  }
  return [...groups].map(([docName, list]) => ({ docName, mentions: list }));
}

export function mentionedPeople(
  mentions: readonly PageMention[],
): { login: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const mention of mentions) counts.set(mention.login, (counts.get(mention.login) ?? 0) + 1);
  return [...counts]
    .map(([login, count]) => ({ login, count }))
    .sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
}

export function snippetKey(text: string): string {
  return text
    .replace(/^…|…$/g, '')
    .replace(/[^\p{L}\p{N}@-]+/gu, '')
    .toLowerCase();
}
