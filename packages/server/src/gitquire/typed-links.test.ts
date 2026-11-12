import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relationLinks } from '@inkeep/open-knowledge-core/gitquire/typed-links';
import { describe, expect, it } from 'vitest';
import { applyRenameMap } from '../apply-managed-rename.ts';
import { BacklinkIndex } from '../backlink-index.ts';
import { createWikiRenameContext } from '../managed-rename-rewrite.ts';
import { createPageScan } from './page-scan.ts';
import { createGitQuireRoutes } from './routes.ts';
import { createTypedLinkListCache, typedLinkList } from './typed-links.ts';

const DECISION_14 = `---
title: Decision 14
supersedes: "[[Decision 9]]"
---

# Decision 14

relates to:: [[Budget]]
See also [[Roadmap]].
`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-typed-links-'));
  mkdirSync(join(dir, 'decisions'), { recursive: true });
  writeFileSync(join(dir, 'decisions', 'decision-14.md'), DECISION_14);
  writeFileSync(join(dir, 'decisions', 'decision-9.md'), '# Decision 9\n');
  writeFileSync(join(dir, 'budget.md'), '# Budget\n\nblocks:: [[Missing Page]]\n');
  return dir;
}

describe('typed link list', () => {
  it('resolves targets like the link index and counts relation names', () => {
    const dir = project();
    try {
      const scan = createPageScan(dir, (_path, markdown) => relationLinks(markdown));
      const list = typedLinkList(scan.all());
      expect(list.truncated).toBe(false);
      expect(list.links).toEqual([
        {
          source: 'budget',
          target: 'Missing Page',
          anchor: null,
          relation: 'blocks',
          origin: 'inline',
          line: 2,
          resolved: false,
        },
        {
          source: 'decisions/decision-14',
          target: 'decisions/decision-9',
          anchor: null,
          relation: 'supersedes',
          origin: 'frontmatter',
          line: 2,
          resolved: true,
        },
        {
          source: 'decisions/decision-14',
          target: 'budget',
          anchor: null,
          relation: 'relates to',
          origin: 'inline',
          line: 7,
          resolved: true,
        },
      ]);
      expect(list.relations).toEqual([
        { name: 'blocks', count: 1 },
        { name: 'relates to', count: 1 },
        { name: 'supersedes', count: 1 },
      ]);
      const cache = createTypedLinkListCache();
      const scanned = scan.all();
      expect(cache.body(scanned)).toBe(cache.body(scanned));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is served to the app', async () => {
    const dir = project();
    try {
      const routes = createGitQuireRoutes({
        projectDir: dir,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        env: {},
      });
      const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
      const res = {
        headersSent: false,
        writableEnded: false,
        writeHead() {
          res.headersSent = true;
          return res;
        },
        end(chunk: string) {
          res.writableEnded = true;
          resolve(JSON.parse(chunk));
          return res;
        },
      };
      const req = { url: '/api/gitquire/typed-links', method: 'GET', headers: {} };
      routes.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      const body = await promise;
      expect(body.links).toHaveLength(3);
      expect(body.relations).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('frontmatter links in the link index', () => {
  it('counts links in frontmatter as backlinks and forward links', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'gq-typed-index-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    try {
      const index = new BacklinkIndex({ projectDir, contentDir });
      index.updateDocumentFromMarkdown('decision-14', DECISION_14);
      index.updateDocumentFromMarkdown('decision-9', '# Decision 9\n');
      expect(index.getForwardLinks('decision-14')).toEqual(['Budget', 'decision-9', 'Roadmap']);
      expect(index.getBacklinks('decision-9')).toEqual([
        expect.objectContaining({ source: 'decision-14' }),
      ]);
      const graph = index.getLinkGraph();
      expect(graph.links).toContainEqual({ source: 'decision-14', target: 'decision-9' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('renaming a page', () => {
  it('updates links in frontmatter as well as in the body', () => {
    const renames = new Map([['A', 'X']]);
    const result = applyRenameMap(
      '---\nsupersedes: "[[A]]"\nrelated:\n  - "[[A]]"\n---\n\nblocks:: [[A]]\n',
      'source',
      createWikiRenameContext(['source', 'A'], renames),
    );
    expect(result.markdown).toBe(
      '---\nsupersedes: "[[X|A]]"\nrelated:\n  - "[[X|A]]"\n---\n\nblocks:: [[X|A]]\n',
    );
    expect(result.rewrites).toBe(3);
  });
});
