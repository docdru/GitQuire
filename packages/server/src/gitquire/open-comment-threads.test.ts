import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CommentThread,
  writeCommentThreads,
} from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  countOpenCommentThreads,
  countOpenCommentThreadsUnder,
  openCommentThreads,
  readOpenCommentThreads,
} from './open-comment-threads.ts';

function thread(id: string, resolved: boolean, bodies: string[]): CommentThread {
  return {
    id,
    anchor: { exact: `passage ${id}` },
    resolved,
    comments: bodies.map((body, index) => ({
      id: `${id}-${index}`,
      author: { id: `u${index}`, login: index === 0 ? 'alice' : 'bob' },
      createdAt: '2026-11-12T10:00:00.000Z',
      body,
    })),
  };
}

const PAGE = writeCommentThreads('# Page\n\nSome text.\n', [
  thread('t1', false, ['@claude please tighten this', 'agreed']),
  thread('t2', true, ['done already']),
  thread('t3', false, ['source?']),
]);

let root: string;

function write(relative: string, content: string) {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gq-open-threads-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('openCommentThreads', () => {
  test('lists unresolved threads with author, first comment, quote and reply count', () => {
    expect(openCommentThreads(PAGE)).toEqual([
      {
        threadId: 't1',
        author: '@alice',
        body: '@claude please tighten this',
        quote: 'passage t1',
        replies: 1,
      },
      { threadId: 't3', author: '@alice', body: 'source?', quote: 'passage t3', replies: 0 },
    ]);
  });

  test('a page without a comment block has no open threads', () => {
    expect(openCommentThreads('# Plain\n')).toEqual([]);
  });
});

describe('reading from disk', () => {
  test('reads one file and returns null when it is missing', async () => {
    write('notes/a.md', PAGE);
    expect(await readOpenCommentThreads(join(root, 'notes/a.md'))).toHaveLength(2);
    expect(await readOpenCommentThreads(join(root, 'notes/missing.md'))).toBeNull();
  });

  test('counts open threads per file and skips files without any', async () => {
    write('a.md', PAGE);
    write('b.md', '# B\n');
    write('c.txt', PAGE);
    expect(await countOpenCommentThreads(root, ['a.md', 'b.md', 'c.txt'])).toEqual(
      new Map([['a.md', 2]]),
    );
  });

  test('counts open threads under a folder by doc name, skipping hidden folders', async () => {
    write('docs/a.md', PAGE);
    write('docs/deep/b.md', PAGE);
    write('docs/.hidden/c.md', PAGE);
    write('other/d.md', PAGE);
    expect(await countOpenCommentThreadsUnder(root, 'docs')).toEqual(
      new Map([
        ['docs/a', 2],
        ['docs/deep/b', 2],
      ]),
    );
  });
});
