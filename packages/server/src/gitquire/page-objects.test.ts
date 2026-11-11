import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fieldValue, listObjects, pageFacts } from './page-objects.ts';
import { createPageScan } from './page-scan.ts';
import { createGitQuireRoutes } from './routes.ts';

const TASK_PAGE = `---
type: task
status: In progress
owner: alice
due: 2026-12-01
tags: [website, launch]
estimate: 3
---

# Rework the landing page

- [ ] Draft the copy @bob
- [x] Collect screenshots
1. [ ] Review with @Alice and @bob

\`\`\`md
- [ ] not a real task
\`\`\`

<!-- gitquire-comments v1
{"id":"t1","anchor":{"exact":"- [ ] hidden"},"resolved":false,"comments":[]}
-->
`;

describe('page facts', () => {
  it('reads fields, the title and action items of a page', () => {
    const facts = pageFacts('tasks/landing-page.md', TASK_PAGE);
    expect(facts.docName).toBe('tasks/landing-page');
    expect(facts.title).toBe('Rework the landing page');
    expect(facts.fields).toEqual({
      type: 'task',
      status: 'In progress',
      owner: 'alice',
      due: '2026-12-01',
      tags: ['website', 'launch'],
      estimate: 3,
    });
    expect(facts.tasks).toEqual([
      { text: 'Draft the copy @bob', done: false, line: 12, mentions: ['bob'] },
      { text: 'Collect screenshots', done: true, line: 13, mentions: [] },
      { text: 'Review with @Alice and @bob', done: false, line: 14, mentions: ['alice', 'bob'] },
    ]);
  });

  it('prefers a title field and falls back to the file name', () => {
    expect(pageFacts('a.md', '---\ntitle: Named\n---\n\n# Heading\n').title).toBe('Named');
    expect(pageFacts('notes/plain.md', 'Just text.\n')).toEqual({
      docName: 'notes/plain',
      title: 'plain',
      fields: {},
      tasks: [],
    });
    expect(pageFacts('broken.md', '---\n: : :\n  - [\n---\n\nText\n').fields).toEqual({});
  });

  it('keeps field values simple and bounded', () => {
    expect(fieldValue(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12-01');
    expect(fieldValue(new Date('2026-12-01T09:30:00Z'))).toBe('2026-12-01T09:30:00.000Z');
    expect(fieldValue(Number.NaN)).toBeNull();
    expect(fieldValue({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: '{"d":1}' } } });
    expect(fieldValue('x'.repeat(600))).toHaveLength(500);
    expect(fieldValue(Array.from({ length: 80 }, (_, index) => index))).toHaveLength(50);
  });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-objects-'));
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(join(dir, 'tasks', 'landing-page.md'), TASK_PAGE);
  writeFileSync(join(dir, 'plain.md'), 'Nothing to see.\n');
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\n- [ ] Call the printer\n');
  return dir;
}

describe('object list', () => {
  it('lists pages that have fields or action items', () => {
    const dir = project();
    try {
      const scan = createPageScan(dir, pageFacts);
      const list = listObjects(scan.all());
      expect(list.truncated).toBe(false);
      expect(list.pages.map((page) => page.docName)).toEqual(['notes', 'tasks/landing-page']);
      expect(list.pages[0]).toMatchObject({ path: 'notes.md', title: 'Notes', fields: {} });
      expect(list.pages[0]?.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
      const req = { url: '/api/gitquire/objects', method: 'GET', headers: {} };
      routes.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      const body = await promise;
      expect(body.truncated).toBe(false);
      expect(body.pages).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
