import { actionItemStatePath, seenActionItemMentions } from '../action-item-mentions.ts';
import type { DraftRecord } from '../drafts/model.ts';
import { reviewMentionsOf } from '../drafts/review-mentions.ts';
import { createDraftStore, draftsStatePath } from '../drafts/store.ts';
import {
  buildInbox,
  createMentionReadStore,
  type Mention,
  type MentionReader,
  mentionStatePath,
  mentionsInMarkdown,
} from '../mentions.ts';
import { type PageFacts, pageFacts } from '../page-objects.ts';
import { createPageScan, type PageScan } from '../page-scan.ts';
import { type WikiRecord, wikiDir } from './wiki-table.ts';

interface ScannedValue {
  mentions: Mention[];
  facts: PageFacts | undefined;
}

export interface MentionCounts {
  unread: (reader: MentionReader, wiki: WikiRecord, selfId?: string) => number;
  mentionsOf: (wiki: WikiRecord, idPrefix: string) => Mention[];
  readIdsOf: (wiki: WikiRecord, accountId: number) => Set<string>;
}

function factsOrNone(path: string, markdown: string): PageFacts | undefined {
  try {
    return pageFacts(path, markdown);
  } catch {
    return undefined;
  }
}

function mentionsOrNone(path: string, markdown: string): Mention[] {
  try {
    return mentionsInMarkdown(path, markdown);
  } catch {
    return [];
  }
}

function draftsOf(dir: string): DraftRecord[] {
  try {
    return createDraftStore(draftsStatePath(dir)).all();
  } catch {
    return [];
  }
}

export function createMentionCounts(dataDir: string, now: () => number = Date.now): MentionCounts {
  const scans = new Map<string, PageScan<ScannedValue>>();

  function scanOf(wiki: WikiRecord): PageScan<ScannedValue> {
    let scan = scans.get(wiki.key);
    if (scan === undefined) {
      scan = createPageScan(
        wikiDir(dataDir, wiki),
        (path, markdown) => ({
          mentions: mentionsOrNone(path, markdown),
          facts: factsOrNone(path, markdown),
        }),
        now,
      );
      scans.set(wiki.key, scan);
    }
    return scan;
  }

  function mentionsOf(wiki: WikiRecord, idPrefix: string): Mention[] {
    const dir = wikiDir(dataDir, wiki);
    const pages = scanOf(wiki).all();
    const comments = pages.flatMap((page) => page.value.mentions);
    const tasks = seenActionItemMentions(
      actionItemStatePath(dir),
      pages.flatMap((page) =>
        page.value.facts === undefined ? [] : [{ path: page.path, facts: page.value.facts }],
      ),
    );
    return [...comments, ...tasks, ...reviewMentionsOf(draftsOf(dir), idPrefix)];
  }

  function readIdsOf(wiki: WikiRecord, accountId: number): Set<string> {
    return createMentionReadStore(mentionStatePath(wikiDir(dataDir, wiki))).readIds(accountId);
  }

  return {
    unread: (reader, wiki, selfId) => {
      const prefix =
        selfId === undefined ? '' : selfId.slice(0, selfId.length - String(reader.id).length);
      const all = mentionsOf(wiki, prefix);
      return buildInbox(reader, all, readIdsOf(wiki, reader.id), selfId).unread;
    },
    mentionsOf,
    readIdsOf,
  };
}
