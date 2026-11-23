import { actionItemStatePath, seenActionItemMentions } from '../action-item-mentions.ts';
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
  unread: (reader: MentionReader, wiki: WikiRecord) => number;
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

  return {
    unread: (reader, wiki) => {
      const dir = wikiDir(dataDir, wiki);
      const pages = scanOf(wiki).all();
      const comments = pages.flatMap((page) => page.value.mentions);
      const tasks = seenActionItemMentions(
        actionItemStatePath(dir),
        pages.flatMap((page) =>
          page.value.facts === undefined ? [] : [{ path: page.path, facts: page.value.facts }],
        ),
      );
      const read = createMentionReadStore(mentionStatePath(dir)).readIds(reader.id);
      return buildInbox(reader, [...comments, ...tasks], read).unread;
    },
  };
}
