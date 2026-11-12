import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createObjectListCache,
  fieldValue,
  headingText,
  listObjects,
  pageFacts,
} from './page-objects.ts';
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

describe('headings', () => {
  it('reads a first-level heading and drops closing marks', () => {
    expect(headingText('# Title')).toBe('Title');
    expect(headingText('# Title ##')).toBe('Title');
    expect(headingText('# C#')).toBe('C#');
    expect(headingText('## Second level')).toBeUndefined();
    expect(headingText('#NoSpace')).toBeUndefined();
    expect(headingText('# ###')).toBeUndefined();
  });

  it('stays fast on a hostile line', () => {
    const line = `# a${' '.repeat(200_000)}b`;
    const started = Date.now();
    expect(headingText(line)).toBe(line.slice(2));
    expect(pageFacts('slow.md', `${line}\n\n# Real title\n`).title).toBe('Real title');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

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
    expect(facts.tasks).toMatchObject([
      { text: 'Draft the copy @bob', done: false, line: 12, mentions: ['bob'] },
      { text: 'Collect screenshots', done: true, line: 13, mentions: [] },
      { text: 'Review with @Alice and @bob', done: false, line: 14, mentions: ['alice', 'bob'] },
    ]);
    expect(facts.clipped).toBe(false);
  });

  it('prefers a title field and falls back to the file name', () => {
    expect(pageFacts('a.md', '---\ntitle: Named\n---\n\n# Heading\n').title).toBe('Named');
    expect(pageFacts('notes/plain.md', 'Just text.\n')).toEqual({
      docName: 'notes/plain',
      title: 'plain',
      fields: {},
      tasks: [],
      clipped: false,
    });
    expect(pageFacts('a.md', '---\ntitle: 2026\n---\n').title).toBe('2026');
    const withBom = pageFacts('a.md', '\uFEFF---\ntype: task\n---\n\n# Bom\n');
    expect(withBom.fields).toEqual({ type: 'task' });
    expect(withBom.title).toBe('Bom');
    expect(pageFacts('broken.md', '---\n: : :\n  - [\n---\n\nText\n').fields).toEqual({});
  });

  it('keeps field values simple and bounded', () => {
    expect(fieldValue(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12-01');
    expect(fieldValue(new Date('2026-12-01T09:30:00Z'))).toBe('2026-12-01T09:30:00.000Z');
    expect(fieldValue(Number.NaN)).toBeNull();
    expect(fieldValue({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: '{"d":1}' } } });
    expect(fieldValue('x'.repeat(600))).toHaveLength(300);
    expect(fieldValue(Array.from({ length: 80 }, (_, index) => index))).toHaveLength(50);
  });
});

describe('hostile and unusual pages', () => {
  it('survives a property that refers to itself', () => {
    const looping = '---\na: &a\n  self: *a\nb: 1\n---\n\n- [ ] Still here\n';
    const facts = pageFacts('loop.md', looping);
    expect(facts.fields.b).toBe(1);
    expect(JSON.stringify(facts.fields)).toContain('[circular]');
    expect(facts.tasks).toHaveLength(1);
  });

  it('ignores property names that would reach the object prototype', () => {
    const sneaky = '---\n__proto__:\n  title: Sneaky\nconstructor: x\n---\n\nText\n';
    const facts = pageFacts('proto.md', sneaky);
    expect(facts.title).toBe('proto');
    expect(Object.keys(facts.fields)).toEqual([]);
    expect(Object.getPrototypeOf(facts.fields)).toBe(Object.prototype);
  });

  it('skips action items in comments and bad fences, and reads quoted ones', () => {
    const body = [
      '<!--',
      '- [ ] commented out',
      '-->',
      '> - [ ] quoted',
      '```md',
      '```js',
      '- [ ] still inside the block',
      '```',
      '- [ ] after the block',
      '',
      '```',
      '<!-- gitquire-comments v1',
      '```',
      '- [ ] after a block that shows the comments marker',
    ].join('\n');
    const texts = pageFacts('a.md', `${body}\n`).tasks.map((item) => item.text);
    expect(texts).toEqual([
      'quoted',
      'after the block',
      'after a block that shows the comments marker',
    ]);
  });

  it('gives action items an id that survives moving lines', () => {
    const before = pageFacts('a.md', '- [ ] Same\n- [ ] Same\n- [ ] Other\n').tasks;
    const moved = 'New first line\n\n- [x] Same\n- [ ] Same\n- [ ] Other\n';
    const after = pageFacts('a.md', moved).tasks;
    expect(new Set(before.map((item) => item.id)).size).toBe(3);
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
    expect(after.map((item) => item.line)).toEqual([3, 4, 5]);
  });

  it('keeps the source line, its place when it repeats, and the due date', () => {
    const source = [
      '---',
      'type: meeting',
      '---',
      '',
      '- [ ] Send notes @bob due: 2026-12-01',
      '  * [x] Same',
      '  * [x] Same',
      '- [ ] Call \u{1F4C5} 2026-02-30',
      '- [ ] Ship \u{1F4C5} 2026-11-20',
      '',
    ].join('\n');
    const tasks = pageFacts('a.md', source).tasks;
    expect(tasks.map((item) => [item.source, item.offset, item.due])).toEqual([
      ['- [ ] Send notes @bob due: 2026-12-01', undefined, '2026-12-01'],
      ['  * [x] Same', source.indexOf('  * [x] Same'), undefined],
      ['  * [x] Same', source.lastIndexOf('  * [x] Same'), undefined],
      ['- [ ] Call \u{1F4C5} 2026-02-30', undefined, undefined],
      ['- [ ] Ship \u{1F4C5} 2026-11-20', undefined, '2026-11-20'],
    ]);
    const crlf = pageFacts('b.md', '# T\r\n- [ ] A\r\n- [ ] A\r\n').tasks;
    expect(crlf.map((item) => item.offset)).toEqual([5, 14]);
  });

  it('marks pages whose properties or action items were cut', () => {
    const many = Array.from({ length: 120 }, (_, index) => `- [ ] Item ${index}`).join('\n');
    const facts = pageFacts('many.md', `${many}\n`);
    expect(facts.tasks).toHaveLength(100);
    expect(facts.clipped).toBe(true);
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

  it('stops at a size budget and reuses the serialized list for the same scan', () => {
    const dir = project();
    try {
      const scanned = createPageScan(dir, pageFacts).all();
      expect(listObjects(scanned, 200)).toMatchObject({ truncated: true });
      expect(listObjects(scanned, 200).pages.length).toBeLessThan(2);
      const cache = createObjectListCache();
      const first = cache.body(scanned);
      expect(cache.body(scanned)).toBe(first);
      expect(JSON.parse(first).pages).toHaveLength(2);
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

describe('content filter', () => {
  it('leaves out pages and folders the server hides', () => {
    const dir = project();
    try {
      mkdirSync(join(dir, 'private'), { recursive: true });
      writeFileSync(join(dir, 'private', 'secret.md'), '---\ntype: task\n---\n');
      const filter = {
        isExcluded: (path: string) => path === 'notes.md',
        isDirExcluded: (path: string) => path === 'private',
      };
      const scan = createPageScan(dir, pageFacts, Date.now, () => filter);
      expect(scan.all().map((page) => page.path)).toEqual(['plain.md', 'tasks/landing-page.md']);
      const open = createPageScan(dir, pageFacts, Date.now, () => undefined);
      expect(
        open
          .all()
          .map((page) => page.path)
          .sort(),
      ).toEqual(['notes.md', 'plain.md', 'private/secret.md', 'tasks/landing-page.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
