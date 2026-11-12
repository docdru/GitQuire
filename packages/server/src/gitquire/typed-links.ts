import { resolveWikiLinkTargetDocName } from '@inkeep/open-knowledge-core';
import type {
  RelationLink,
  RelationOrigin,
} from '@inkeep/open-knowledge-core/gitquire/typed-links';
import { buildProjectWikiLinkLookup } from '../project-wiki-link-lookup.ts';
import { docNameForPath, type ScannedPage } from './page-scan.ts';

const MAX_LINKS = 20_000;

export interface TypedLink {
  source: string;
  target: string;
  anchor: string | null;
  relation: string;
  origin: RelationOrigin;
  line: number;
  resolved: boolean;
}

export interface RelationName {
  name: string;
  count: number;
}

export interface TypedLinkList {
  links: TypedLink[];
  relations: RelationName[];
  truncated: boolean;
}

export function typedLinkList(
  pages: readonly ScannedPage<readonly RelationLink[]>[],
): TypedLinkList {
  const sources = pages.map((page) => ({ page, docName: docNameForPath(page.path) ?? page.path }));
  const lookup = buildProjectWikiLinkLookup(sources.map((source) => source.docName));
  const links: TypedLink[] = [];
  const counts = new Map<string, number>();
  let truncated = false;
  for (const { page, docName } of sources) {
    for (const link of page.value) {
      if (links.length >= MAX_LINKS) {
        truncated = true;
        break;
      }
      const target = resolveWikiLinkTargetDocName(link.target, lookup);
      links.push({
        source: docName,
        target: target ?? link.target,
        anchor: link.anchor,
        relation: link.relation,
        origin: link.origin,
        line: link.line,
        resolved: target !== undefined,
      });
      counts.set(link.relation, (counts.get(link.relation) ?? 0) + 1);
    }
  }
  const relations = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { links, relations, truncated };
}

export function createTypedLinkListCache(): {
  body: (pages: readonly ScannedPage<readonly RelationLink[]>[]) => string;
} {
  let cached: { pages: unknown; body: string } | undefined;
  return {
    body(pages) {
      if (cached?.pages !== pages) {
        cached = { pages, body: JSON.stringify(typedLinkList(pages)) };
      }
      return cached.body;
    },
  };
}
