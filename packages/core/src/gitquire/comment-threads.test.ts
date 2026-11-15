import { getSchema } from '@tiptap/core';
import { EditorState, type Plugin } from '@tiptap/pm/state';
import { describe, expect, test } from 'vitest';
import { ALLOW_COMMENT_TRAILER_REMOVAL } from '../extensions/gitquire-comments.ts';
import { sharedExtensions } from '../extensions/shared.ts';
import { MarkdownManager } from '../markdown/index.ts';
import {
  COMMENT_TRAILER_CLOSE,
  COMMENT_TRAILER_OPEN,
  type CommentThread,
  checkCommentsAfterOutsideChange,
  convertCommentsToFootnotes,
  joinCommentTrailer,
  pageTextWithoutComments,
  parseCommentTrailer,
  readCommentThreads,
  serializeCommentTrailer,
  splitCommentTrailer,
  writeCommentThreads,
} from './comment-threads.ts';

const thread: CommentThread = {
  id: 'c-7f3a',
  anchor: { exact: 'quarterly numbers' },
  resolved: false,
  comments: [
    {
      id: 'c-7f3a/alice/2026-11-14T10:32:00.000Z',
      author: { id: 'alice', login: 'alice' },
      createdAt: '2026-11-14T10:32:00.000Z',
      body: 'Where do these come from? @bob',
      mentions: ['bob'],
    },
    {
      id: 'c-7f3a/bob/2026-11-14T11:02:00.000Z',
      author: { id: 'bob', login: 'bob' },
      createdAt: '2026-11-14T11:02:00.000Z',
      editedAt: '2026-11-14T11:05:00.000Z',
      body: 'From the Q3 controlling export.\nSecond line.',
    },
  ],
};

const trailer = [
  '[^c-7f3a]: 💬 on "quarterly numbers"',
  '',
  '    - **@alice** · 2026-11-14 10:32 — Where do these come from? @bob',
  '    - **@bob** · 2026-11-14 11:02 · edited 2026-11-14 11:05 — From the Q3 controlling export.',
  '      Second line.',
].join('\n');

const page = `The quarterly numbers[^c-7f3a] look good.\n\n${trailer}\n`;

function legacyBlock(threads: unknown[]): string {
  return `${COMMENT_TRAILER_OPEN}\n${threads.map((t) => JSON.stringify(t)).join('\n')}\n${COMMENT_TRAILER_CLOSE}`;
}

const legacyThread = {
  id: 't1',
  anchor: { exact: 'quarterly numbers', prefix: 'The ', suffix: ' look good.' },
  resolved: false,
  comments: [
    {
      id: 'c1',
      author: { id: 'github-42', login: 'alice' },
      createdAt: '2026-11-14T10:32:07.120Z',
      body: 'Where do these come from?',
      mentions: [],
    },
  ],
};

describe('footnote thread format', () => {
  test('writes the canonical shape and reads it back', () => {
    expect(serializeCommentTrailer([thread])).toBe(trailer);
    expect(parseCommentTrailer(trailer)).toEqual({ threads: [thread], skippedLines: 0 });
  });

  test('splits comment definitions off the page and leaves real footnotes', () => {
    const md = `Text[^1] and numbers[^c-7f3a].\n\n[^1]: Real.\n\n${trailer}\n`;
    expect(splitCommentTrailer(md)).toEqual({
      body: 'Text[^1] and numbers[^c-7f3a].\n\n[^1]: Real.\n',
      trailer,
    });
  });

  test('reads tolerant forms', () => {
    const loose = [
      '[^c-1a2b]: 💬 on "plan"',
      '    - @hans: plain form',
      '    - **@ina** — no date',
      '- @jo: written without indentation',
    ].join('\n');
    const [parsed] = parseCommentTrailer(loose).threads;
    expect(parsed?.comments.map((c) => [c.author.login, c.body, c.createdAt])).toEqual([
      ['hans', 'plain form', ''],
      ['ina', 'no date', ''],
      ['jo', 'written without indentation', ''],
    ]);
    expect(serializeCommentTrailer(parsed ? [parsed] : [])).toBe(
      [
        '[^c-1a2b]: 💬 on "plan"',
        '',
        '    - **@hans** — plain form',
        '    - **@ina** — no date',
        '    - **@jo** — written without indentation',
      ].join('\n'),
    );
  });

  test('keeps a line it cannot read instead of dropping it', () => {
    const damaged = `${trailer}\n    some note without author\n    - not a comment`;
    const parsed = parseCommentTrailer(damaged);
    expect(parsed.skippedLines).toBe(2);
    expect(parsed.threads[0]?.unreadable).toEqual(['some note without author', '- not a comment']);
    const again = serializeCommentTrailer(parsed.threads) as string;
    expect(again).toContain('    some note without author');
    expect(parseCommentTrailer(again).threads[0]?.unreadable).toHaveLength(2);
  });

  test('a definition without the header is still a thread', () => {
    const [parsed] = parseCommentTrailer('[^c-9]: - @kai: hello').threads;
    expect(parsed?.anchor.exact).toBe('');
    expect(parsed?.comments[0]?.body).toBe('hello');
  });

  test('quotes with quotation marks survive', () => {
    const quoted: CommentThread = { ...thread, anchor: { exact: 'the "best" plan' } };
    const raw = serializeCommentTrailer([quoted]) as string;
    expect(raw.split('\n')[0]).toBe('[^c-7f3a]: 💬 on "the \\"best\\" plan"');
    expect(parseCommentTrailer(raw).threads[0]?.anchor.exact).toBe('the "best" plan');
  });

  test('ignores comment definitions inside code fences', () => {
    const md = `\`\`\`md\n${trailer}\n\`\`\`\n`;
    expect(splitCommentTrailer(md).trailer).toBeUndefined();
  });

  test('resolved threads leave the file', () => {
    expect(serializeCommentTrailer([{ ...thread, resolved: true }])).toBeUndefined();
    expect(writeCommentThreads(page, [])).toBe('The quarterly numbers[^c-7f3a] look good.\n');
  });

  test('reads and writes whole pages', () => {
    expect(readCommentThreads(page)).toEqual([thread]);
    expect(writeCommentThreads(page, [thread])).toBe(page);
    expect(joinCommentTrailer('Body\n\n\n', trailer)).toBe(`Body\n\n${trailer}\n`);
  });

  test('page text without comments drops marks and threads', () => {
    expect(pageTextWithoutComments(page)).toBe('The quarterly numbers look good.\n');
  });
});

describe('v1 blocks', () => {
  const v1 = `The quarterly numbers look good.\n\n${legacyBlock([legacyThread])}\n`;

  test('convert to footnote threads with a mark at the quote', () => {
    const out = convertCommentsToFootnotes(v1);
    expect(out).toMatch(/^The quarterly numbers\[\^c-[0-9a-f]{4}\] look good\.\n\n\[\^c-/);
    const [converted] = readCommentThreads(out);
    expect(converted?.comments[0]).toMatchObject({
      author: { login: 'alice' },
      createdAt: '2026-11-14T10:32:00.000Z',
      body: 'Where do these come from?',
    });
    expect(convertCommentsToFootnotes(out)).toBe(out);
    expect(convertCommentsToFootnotes(v1)).toBe(out);
  });

  test('a quote that occurs twice gets no mark unless the context decides', () => {
    const twice = `Numbers here. Numbers there.\n\n${legacyBlock([
      { ...legacyThread, anchor: { exact: 'Numbers' } },
      { ...legacyThread, id: 't2', anchor: { exact: 'Numbers', prefix: 'here. ' } },
    ])}\n`;
    const out = convertCommentsToFootnotes(twice);
    expect(out.split('\n')[0]).toMatch(/^Numbers here\. Numbers\[\^c-[0-9a-f]+\] there\.$/);
    expect(readCommentThreads(out)).toHaveLength(2);
  });

  test('never marks headings or code', () => {
    const md = `# Plan\n\n\`\`\`\nPlan\n\`\`\`\n\n${legacyBlock([{ ...legacyThread, anchor: { exact: 'Plan' } }])}\n`;
    const out = convertCommentsToFootnotes(md);
    expect(out.startsWith('# Plan\n\n```\nPlan\n```\n')).toBe(true);
    expect(readCommentThreads(out)[0]?.anchor.exact).toBe('Plan');
  });

  test('drops resolved threads and keeps lines that do not parse', () => {
    const md = `Body\n\n${legacyBlock([{ ...legacyThread, resolved: true }])}`.replace(
      `\n${COMMENT_TRAILER_CLOSE}`,
      `\nnot json\n${COMMENT_TRAILER_CLOSE}`,
    );
    const threads = readCommentThreads(md);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.unreadable).toEqual(['not json']);
  });
});

describe('markdown pipeline', () => {
  const md = new MarkdownManager({ extensions: sharedExtensions });

  test('round-trips a page with marks, real footnotes and a table byte-identically', () => {
    const source = `# Notes\n\nThe quarterly numbers[^c-7f3a] look good[^1].\n\n| A | B |\n| --- | --- |\n| North[^c-7f3a] | 1 |\n\n[^1]: Real.\n\n${trailer}\n`;
    const json = md.parse(source);
    expect(json.content?.at(-1)?.type).toBe('gitquireComments');
    expect(JSON.stringify(json)).toContain('"type":"gitquireCommentMark"');
    expect(md.serialize(json)).toBe(source);
  });

  test('an escaped mark stays escaped', () => {
    const json = md.parse(`Text \\[^c-7f3a] here.\n\n${trailer}\n`);
    expect(JSON.stringify(json)).not.toContain('gitquireCommentMark');
    expect(md.serialize(json).split('\n')[0]).toBe('Text \\[^c-7f3a] here.');
  });

  test('a mark for an unknown label stays text', () => {
    const json = md.parse('Text[^c-dead] here.\n');
    expect(JSON.stringify(json)).not.toContain('gitquireCommentMark');
  });

  test('drops a mark whose thread is gone when writing', () => {
    const json = md.parse(page);
    json.content = json.content?.filter((node) => node.type !== 'gitquireComments');
    expect(md.serialize(json)).toBe('The quarterly numbers look good.\n');
  });

  test('moves a comment definition from the middle of a page to the end', () => {
    const out = md.serialize(md.parse(`Intro numbers[^c-7f3a]\n\n${trailer}\n\nOutro\n`));
    expect(out).toBe(`Intro numbers[^c-7f3a]\n\nOutro\n\n${trailer}\n`);
  });

  test('converts a v1 page on the next save', () => {
    const v1 = `The quarterly numbers look good.\n\n${legacyBlock([legacyThread])}\n`;
    expect(md.serialize(md.parse(v1))).toBe(convertCommentsToFootnotes(v1));
  });

  test('leaves ordinary HTML comments alone', () => {
    const json = md.parse('Text\n\n<!-- a note -->\n');
    expect(json.content?.some((node) => node.type === 'gitquireComments')).toBe(false);
    expect(md.serialize(json)).toBe('Text\n\n<!-- a note -->\n');
  });
});

describe('editor guard', () => {
  const schema = getSchema(sharedExtensions);
  const md = new MarkdownManager({ extensions: sharedExtensions });
  const doc = schema.nodeFromJSON(md.parse(page));

  function stateWithGuard() {
    const extension = sharedExtensions.find((e) => e.name === 'gitquireComments');
    const create = extension?.config.addProseMirrorPlugins as (() => Plugin[]) | undefined;
    return EditorState.create({ schema, doc, plugins: create?.call({}) ?? [] });
  }

  test('restores the threads when an edit deletes everything', () => {
    const state = stateWithGuard();
    const next = state.applyTransaction(state.tr.delete(0, state.doc.content.size)).state;
    expect(next.doc.lastChild?.type.name).toBe('gitquireComments');
  });

  test('allows removal when the transaction says so', () => {
    const state = stateWithGuard();
    const tr = state.tr.delete(0, state.doc.content.size);
    tr.setMeta(ALLOW_COMMENT_TRAILER_REMOVAL, true);
    let found = false;
    state.applyTransaction(tr).state.doc.forEach((child) => {
      if (child.type.name === 'gitquireComments') found = true;
    });
    expect(found).toBe(false);
  });
});

describe('comment check after an outside change', () => {
  const second = [
    '[^c-91bd]: 💬 on "forecast"',
    '',
    '    - **@carol** · 2026-11-14 12:00 — March or June?',
  ].join('\n');
  const before = `The quarterly numbers[^c-7f3a] look good, the forecast[^c-91bd] is stable.\n\n${trailer}\n\n${second}\n`;

  test('restores a thread an outside commit dropped while its mark is still there', () => {
    const after = `The quarterly numbers[^c-7f3a] look great, the forecast[^c-91bd] is stable.\n\n${trailer}\n`;
    const check = checkCommentsAfterOutsideChange(before, after);
    expect(check.restored).toEqual(['c-91bd']);
    expect(readCommentThreads(check.markdown).map((t) => t.id)).toEqual(['c-7f3a', 'c-91bd']);
    expect(check.markdown).toContain('look great');
  });

  test('accepts a thread removed together with its mark', () => {
    const after = `The quarterly numbers[^c-7f3a] look good, the forecast is stable.\n\n${trailer}\n`;
    expect(checkCommentsAfterOutsideChange(before, after)).toEqual({
      markdown: after,
      restored: [],
      relinked: [],
    });
  });

  test('puts a lost mark back when the quote is still there once', () => {
    const after = `Now the quarterly numbers look good, the forecast[^c-91bd] is stable.\n\n${trailer}\n\n${second}\n`;
    const check = checkCommentsAfterOutsideChange(before, after);
    expect(check.relinked).toEqual(['c-7f3a']);
    expect(check.markdown.split('\n')[0]).toBe(
      'Now the quarterly numbers[^c-7f3a] look good, the forecast[^c-91bd] is stable.',
    );
  });

  test('leaves a page alone when nothing about its comments changed', () => {
    const after = before.replace('stable', 'steady');
    expect(checkCommentsAfterOutsideChange(before, after).markdown).toBe(after);
  });
});
