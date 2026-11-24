import type { Node as PMNode } from '@tiptap/pm/model';
import { snippetKey } from '@/lib/gitquire/page-mentions';
import type { PageMentionTarget } from './mention-events';

export const MENTION_RE = /(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\w-])/g;

export type MentionPlace = 'page' | 'action-item' | 'done-action-item';

export interface MentionRange {
  from: number;
  to: number;
  login: string;
  place: MentionPlace;
  block: PMNode;
}

function isCode(node: PMNode): boolean {
  return node.marks.some((mark) => mark.type.name === 'code');
}

function placeOf(doc: PMNode, pos: number): { place: MentionPlace; block: PMNode } {
  const $pos = doc.resolve(pos);
  let place: MentionPlace = 'page';
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === 'listItem' && node.attrs.checked !== null) {
      place = node.attrs.checked === true ? 'done-action-item' : 'action-item';
      break;
    }
  }
  return { place, block: $pos.parent };
}

export function mentionRanges(doc: PMNode): MentionRange[] {
  const found: MentionRange[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code === true) return false;
    if (!node.isText || isCode(node)) return true;
    const text = node.text ?? '';
    if (!text.includes('@')) return false;
    for (const match of text.matchAll(MENTION_RE)) {
      const from = pos + (match.index ?? 0);
      const { place, block } = placeOf(doc, from);
      found.push({
        from,
        to: from + match[0].length,
        login: (match[1] as string).toLowerCase(),
        place,
        block,
      });
    }
    return false;
  });
  return found;
}

export function mentionAt(doc: PMNode, pos: number): MentionRange | undefined {
  return mentionRanges(doc).find((range) => range.from <= pos && pos <= range.to);
}

export function findPageMention(
  doc: PMNode,
  target: Pick<PageMentionTarget, 'login' | 'occurrence' | 'snippet'>,
): MentionRange | undefined {
  const login = target.login.toLowerCase();
  const candidates = mentionRanges(doc).filter(
    (range) => range.place === 'page' && range.login === login,
  );
  if (candidates.length === 0) return undefined;
  const key = snippetKey(target.snippet);
  const bySnippet = candidates.filter((range) => {
    const blockKey = snippetKey(range.block.textContent);
    return key !== '' && (blockKey.includes(key) || key.includes(blockKey));
  });
  const byOccurrence = candidates[target.occurrence];
  if (byOccurrence !== undefined && (bySnippet.length === 0 || bySnippet.includes(byOccurrence))) {
    return byOccurrence;
  }
  return bySnippet[0] ?? candidates[0];
}
