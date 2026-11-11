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

  test('splits only a trailer at the very end', () => {
    const md = `# Title\n\nBody text.\n\n${trailer}\n`;
    expect(splitCommentTrailer(md)).toEqual({ body: '# Title\n\nBody text.\n', trailer });
    expect(splitCommentTrailer(`${trailer}\n\nmore text\n`).trailer).toBeUndefined();
    expect(splitCommentTrailer('plain\n').trailer).toBeUndefined();
    expect(splitCommentTrailer(`${trailer}\n`)).toEqual({ body: '', trailer });
  });

  test('ignores a trailer inside an unclosed code fence', () => {
    const md = `\`\`\`md\nexample\n${trailer}\n`;
    expect(splitCommentTrailer(md).trailer).toBeUndefined();
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
    const only = `${trailer}\n`;
    expect(md.serialize(md.parse(only))).toBe(only);
  });

  test('leaves ordinary HTML comments alone', () => {
    const plain = 'Text\n\n<!-- a note -->\n';
    expect(md.serialize(md.parse(plain))).toBe(plain);
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
