import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CONVERT_COMMIT_MESSAGE, convertAllPages } from './comments.ts';

const v1 = `The quarterly numbers look good.\n\n<!-- gitquire-comments v1\n${JSON.stringify({
  id: 't1',
  anchor: { exact: 'quarterly numbers' },
  resolved: false,
  comments: [
    {
      id: 'c1',
      author: { id: 'g', login: 'alice' },
      createdAt: '2026-11-14T10:32:00Z',
      body: 'Source?',
    },
  ],
})}\n-->\n`;

let dir: string | undefined;
const IDENTITY = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];
const savedIdentity = IDENTITY.map((key) => [key, process.env[key]] as const);

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  for (const [key, value] of savedIdentity) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

describe('comments convert', () => {
  test('converts v1 pages in one commit and leaves other pages alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gq-convert-'));
    mkdirSync(join(dir, 'notes'));
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, 'a.md'), v1);
    writeFileSync(join(dir, 'notes', 'b.md'), v1);
    writeFileSync(join(dir, 'plain.md'), '# Nothing here\n');
    writeFileSync(join(dir, '.hidden', 'c.md'), v1);
    git(dir, 'init', '-q');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '.');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'seed');

    const dry = await convertAllPages(dir, { dryRun: true, commit: true });
    expect(dry).toEqual({ converted: ['a.md', 'notes/b.md'], committed: false });
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe(v1);

    for (const key of IDENTITY) process.env[key] = key.endsWith('EMAIL') ? 't@example.com' : 't';
    const result = await convertAllPages(dir, { dryRun: false, commit: true });
    expect(result).toEqual({ converted: ['a.md', 'notes/b.md'], committed: true });
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toMatch(/^The quarterly numbers\[\^c-/);
    expect(readFileSync(join(dir, '.hidden', 'c.md'), 'utf8')).toBe(v1);
    expect(git(dir, 'log', '--format=%s').trim().split('\n')).toEqual([
      CONVERT_COMMIT_MESSAGE,
      'seed',
    ]);
    expect(await convertAllPages(dir, { dryRun: false, commit: true })).toEqual({
      converted: [],
      committed: false,
    });
  });
});
