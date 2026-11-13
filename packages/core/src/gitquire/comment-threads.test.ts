import { getSchema } from '@tiptap/core';
import { EditorState, type Plugin } from '@tiptap/pm/state';
import { describe, expect, test } from 'vitest';
import { ALLOW_COMMENT_TRAILER_REMOVAL } from '../extensions/gitquire-comments.ts';
import { sharedExtensions } from '../extensions/shared.ts';
import { MarkdownManager } from '../markdown/index.ts';
import {
  type CommentThread,
  joinCommentTrailer,
  parseCommentTrailer,
  readCommentThreads,
  serializeCommentTrailer,
  splitCommentTrailer,
  type ThreadComment,
  writeCommentThreads,
} from './comment-threads.ts';

const thread: CommentThread = {
  id: 't1',
  anchor: { exact: 'quarterly numbers', prefix: 'the ', suffix: ' look' },
  resolved: false,
  comments: [
    {
      id: 'c1',
      author: { id: 'github-42', login: 'alice', name: 'Alice' },
      createdAt: '2026-11-11T10:00:00Z',
      body: 'Is this --> safe? <!-- and -- this',
      mentions: ['bob'],
    },
    {
      id: 'c2',
      author: { id: 'github-7', login: 'bob' },
      createdAt: '2026-11-11T10:05:00Z',
      body: 'Line one\nline two',
    },
  ],
};

const trailer = serializeCommentTrailer([thread]) as string;

describe('comment trailer format', () => {
  test('round-trips threads and never closes the HTML comment early', () => {
    const inner = trailer.slice('<!--'.length, -'-->'.length);
    expect(inner).not.toContain('--');
    expect(trailer.split('\n')).toHaveLength(3);
    expect(parseCommentTrailer(trailer)).toEqual({ threads: [thread], skippedLines: 0 });
  });

  test('skips malformed lines instead of failing', () => {
    const damaged = trailer.replace('\n-->', '\nnot json\n{"id":"x"}\n-->');
    expect(parseCommentTrailer(damaged)).toEqual({ threads: [thread], skippedLines: 2 });
  });

  test('splits the trailer from the end of the page', () => {
    const md = `# Title\n\nBody text.\n\n${trailer}\n`;
    expect(splitCommentTrailer(md)).toEqual({ body: '# Title\n\nBody text.\n', trailer });
    expect(splitCommentTrailer(`${trailer}\n\nmore text\n`)).toEqual({
      body: 'more text\n',
      trailer,
    });
    expect(splitCommentTrailer('plain\n').trailer).toBeUndefined();
    expect(splitCommentTrailer(`${trailer}\n`)).toEqual({ body: '', trailer });
  });

  test('ignores a trailer inside an unclosed code fence', () => {
    const md = `\`\`\`md\nexample\n${trailer}\n`;
    expect(splitCommentTrailer(md).trailer).toBeUndefined();
  });

  test('folds copies a merge left in the body into one trailer at the end', () => {
    const body = '# Roadmap\n\nPlan text.\n';
    const md = `${body}\n${trailer}\n\n${body}\n${trailer}\n\n${body}\n${trailer}\n`;
    const split = splitCommentTrailer(md);
    expect(split.trailer).toBe(trailer);
    expect(split.body).not.toContain('gitquire-comments');
    expect(split.body.match(/# Roadmap/g)).toHaveLength(3);
  });

  test('recovers a copy when the file no longer ends with a trailer', () => {
    const split = splitCommentTrailer(`Intro\n\n${trailer}\n\nMore text\n`);
    expect(split).toEqual({ body: 'Intro\n\nMore text\n', trailer });
  });

  test('merges threads that appear in more than one copy', () => {
    const [first, second] = thread.comments as [ThreadComment, ThreadComment];
    const older = serializeCommentTrailer([{ ...thread, comments: [first] }]);
    const newer = serializeCommentTrailer([
      { ...thread, resolved: true, comments: [second] },
      { ...thread, id: 't2', comments: [first] },
    ]);
    const split = splitCommentTrailer(`Body\n\n${older}\n\nTail\n\n${newer}\n`);
    expect(split.body).toBe('Body\n\nTail\n');
    expect(parseCommentTrailer(split.trailer as string).threads).toEqual([
      { ...thread, resolved: true },
      { ...thread, id: 't2', comments: [first] },
    ]);
  });

  test('leaves a copy inside a code fence alone', () => {
    const md = `\`\`\`md\n${trailer}\n\`\`\`\n\n${trailer}\n`;
    expect(splitCommentTrailer(md)).toEqual({ body: `\`\`\`md\n${trailer}\n\`\`\`\n`, trailer });
  });

  test('normalizes the join and supports removing every thread', () => {
    expect(joinCommentTrailer('Body\n\n\n', trailer)).toBe(`Body\n\n${trailer}\n`);
    const md = writeCommentThreads('Body\n', [thread]);
    expect(readCommentThreads(md)).toEqual([thread]);
    expect(writeCommentThreads(md, [])).toBe('Body\n');
  });
});

describe('markdown pipeline carries the trailer', () => {
  const md = new MarkdownManager({ extensions: sharedExtensions });
  const source = `# Notes\n\nThe quarterly numbers look good.\n\n- one\n- two\n\n${trailer}\n`;

  test('parses into a trailing atom node and serializes byte-identically', () => {
    const json = md.parse(source);
    const last = json.content?.at(-1);
    expect(last?.type).toBe('gitquireComments');
    expect(last?.attrs?.raw).toBe(trailer);
    expect(md.serialize(json)).toBe(source);
  });

  test('keeps the trailer last when content is added after it', () => {
    const json = md.parse(source);
    json.content?.push({ type: 'paragraph', content: [{ type: 'text', text: 'Added.' }] });
    expect(md.serialize(json)).toBe(
      `# Notes\n\nThe quarterly numbers look good.\n\n- one\n- two\n\nAdded.\n\n${trailer}\n`,
    );
  });

  test('exposes the trailer as its own mdast node', () => {
    const children = md.parseToMdast(source).children;
    expect(children.at(-1)).toEqual({ type: 'gitquireComments', value: trailer });
    expect(md.parseToEditorMdast(source).children.at(-1)?.type).toBe('gitquireComments');
  });

  test('handles a document that only holds comments', () => {
    const json = md.parse(`${trailer}\n`);
    expect(json.content?.at(-1)?.type).toBe('gitquireComments');
    expect(md.serialize(json)).toBe(`${trailer}\n`);
  });

  test('moves a copied comment section from the middle of a page to the end', () => {
    const json = md.parse(`Intro\n\n${trailer}\n\nOutro\n`);
    const out = md.serialize(json);
    expect(splitCommentTrailer(out)).toEqual({ body: 'Intro\n\nOutro\n', trailer });
    expect(out.split('gitquire-comments')).toHaveLength(2);
  });

  test('does not move a hand-written marker that holds no threads', () => {
    const marker = '<!-- gitquire-comments v1\nnotes\n-->';
    const json = md.parse(`Intro\n\n${marker}\n\nOutro\n`);
    expect(json.content?.some((node) => node.type === 'gitquireComments')).toBe(false);
    expect(md.serialize(json).trimEnd().endsWith('Outro')).toBe(true);
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
  const doc = schema.nodeFromJSON(md.parse(`Hello\n\n${trailer}\n`));

  function stateWithGuard() {
    const extension = sharedExtensions.find((e) => e.name === 'gitquireComments');
    const create = extension?.config.addProseMirrorPlugins as (() => Plugin[]) | undefined;
    return EditorState.create({ schema, doc, plugins: create?.call({}) ?? [] });
  }

  test('restores the trailer when an edit deletes everything', () => {
    const state = stateWithGuard();
    const tr = state.tr.delete(0, state.doc.content.size);
    const next = state.applyTransaction(tr).state;
    expect(next.doc.lastChild?.type.name).toBe('gitquireComments');
  });

  test('allows removal when the transaction says so', () => {
    const state = stateWithGuard();
    const tr = state.tr.delete(0, state.doc.content.size);
    tr.setMeta(ALLOW_COMMENT_TRAILER_REMOVAL, true);
    const next = state.applyTransaction(tr).state;
    let found = false;
    next.doc.forEach((child) => {
      if (child.type.name === 'gitquireComments') found = true;
    });
    expect(found).toBe(false);
  });
});
