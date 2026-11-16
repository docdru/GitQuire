import {
  asTargetNamespace,
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  toWikiLinkSlug,
  type WikiLinkLookupIndex,
} from '@inkeep/open-knowledge-core';

export function buildProjectWikiLinkLookup(docNames: Iterable<string>): WikiLinkLookupIndex {
  const pages = asTargetNamespace('document', docNames);
  const projectPages = new Set(pages);
  return {
    pages,
    pagesBySlug: buildPagesBySlugIndex(projectPages, toWikiLinkSlug),
    pagesByBasename: buildPagesByBasenameIndex(projectPages, toWikiLinkSlug),
  };
}
