import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { nestedOkPath, parentFolderOf, readFolderFrontmatter } from './nested-folder-rules.ts';

describe('readFolderFrontmatter — self-only (no cascade)', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'folder-frontmatter-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('returns empty for project root when no .gitquire/frontmatter.yml exists there', () => {
    expect(readFolderFrontmatter(projectDir, '')).toEqual({});
    expect(readFolderFrontmatter(projectDir, '.')).toEqual({});
    expect(readFolderFrontmatter(projectDir, '/')).toEqual({});
  });

  test('returns empty when the folder has no .gitquire/frontmatter.yml', () => {
    expect(readFolderFrontmatter(projectDir, 'meetings')).toEqual({});
    expect(readFolderFrontmatter(projectDir, 'meetings/prep-notes')).toEqual({});
  });

  test("reads a folder's own .gitquire/frontmatter.yml", () => {
    mkdirSync(join(projectDir, 'meetings', '.gitquire'), { recursive: true });
    writeFileSync(
      join(projectDir, 'meetings', '.gitquire', 'frontmatter.yml'),
      'title: Meetings\ndescription: Meeting notes\ntags: [meeting]\n',
    );

    expect(readFolderFrontmatter(projectDir, 'meetings')).toEqual({
      title: 'Meetings',
      description: 'Meeting notes',
      tags: ['meeting'],
    });
  });

  test('treats a symlinked frontmatter.yml leaf as absent', () => {
    const secret = join(projectDir, 'secret.yml');
    writeFileSync(secret, 'title: Stolen\ndescription: exfiltrated\n');
    mkdirSync(join(projectDir, 'linked', '.gitquire'), { recursive: true });
    symlinkSync(secret, join(projectDir, 'linked', '.gitquire', 'frontmatter.yml'));
    expect(readFolderFrontmatter(projectDir, 'linked')).toEqual({});
  });

  test('treats a leaf behind an IN-ROOT symlinked .gitquire as absent', () => {
    mkdirSync(join(projectDir, 'secretdir'), { recursive: true });
    writeFileSync(join(projectDir, 'secretdir', 'frontmatter.yml'), 'title: AliasedInRoot\n');
    mkdirSync(join(projectDir, 'aliased'), { recursive: true });
    symlinkSync('../secretdir', join(projectDir, 'aliased', '.gitquire'), 'dir');
    expect(readFolderFrontmatter(projectDir, 'aliased')).toEqual({});
  });

  test('treats a leaf behind an out-of-root symlinked .gitquire ancestor as absent', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'folder-frontmatter-outside-'));
    try {
      writeFileSync(join(outside, 'frontmatter.yml'), 'title: OutsideSecret\n');
      mkdirSync(join(projectDir, 'escaped'), { recursive: true });
      symlinkSync(outside, join(projectDir, 'escaped', '.gitquire'), 'dir');
      expect(readFolderFrontmatter(projectDir, 'escaped')).toEqual({});
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('does NOT inherit from ancestor folders (self-only)', () => {
    mkdirSync(join(projectDir, 'a', '.gitquire'), { recursive: true });
    writeFileSync(
      join(projectDir, 'a', '.gitquire', 'frontmatter.yml'),
      'title: A\ndescription: A desc\ntags: [a]\n',
    );
    mkdirSync(join(projectDir, 'a', 'b', '.gitquire'), { recursive: true });
    writeFileSync(join(projectDir, 'a', 'b', '.gitquire', 'frontmatter.yml'), 'title: B\n');

    expect(readFolderFrontmatter(projectDir, 'a/b')).toEqual({ title: 'B' });
    expect(readFolderFrontmatter(projectDir, 'a')).toEqual({
      title: 'A',
      description: 'A desc',
      tags: ['a'],
    });
  });

  test('a child with no .gitquire/frontmatter.yml returns empty even when an ancestor has one', () => {
    mkdirSync(join(projectDir, '.gitquire'), { recursive: true });
    writeFileSync(join(projectDir, '.gitquire', 'frontmatter.yml'), 'title: Project\ntags: [kb]\n');

    expect(readFolderFrontmatter(projectDir, 'meetings')).toEqual({});
    expect(readFolderFrontmatter(projectDir, '')).toEqual({ title: 'Project', tags: ['kb'] });
  });

  test('malformed YAML returns empty (read paths must not throw)', () => {
    mkdirSync(join(projectDir, 'broken', '.gitquire'), { recursive: true });
    writeFileSync(
      join(projectDir, 'broken', '.gitquire', 'frontmatter.yml'),
      'title: [malformed\nno closing\n',
    );

    expect(readFolderFrontmatter(projectDir, 'broken')).toEqual({});
  });

  test('non-string title dropped; non-string tags filtered (well-known narrowing)', () => {
    mkdirSync(join(projectDir, 'mixed', '.gitquire'), { recursive: true });
    writeFileSync(
      join(projectDir, 'mixed', '.gitquire', 'frontmatter.yml'),
      'title: 42\ndescription: ok\ntags: [a, 1, b, true]\n',
    );

    expect(readFolderFrontmatter(projectDir, 'mixed')).toEqual({
      description: 'ok',
      tags: ['a', 'b'],
    });
  });

  test('arbitrary (non-well-known) keys pass through with their natural types', () => {
    mkdirSync(join(projectDir, 'rfcs', '.gitquire'), { recursive: true });
    writeFileSync(
      join(projectDir, 'rfcs', '.gitquire', 'frontmatter.yml'),
      'title: RFCs\nstatus: draft\nreview_cycle: 30\nowners: [alice, bob]\n',
    );

    const own = readFolderFrontmatter(projectDir, 'rfcs');
    expect(own.title).toBe('RFCs');
    expect(own.status).toBe('draft');
    expect(own.review_cycle).toBe(30);
    expect(own.owners).toEqual(['alice', 'bob']);
  });
});

describe('parentFolderOf', () => {
  test('extracts parent dir from a file path', () => {
    expect(parentFolderOf('meetings/foo.md')).toBe('meetings');
    expect(parentFolderOf('meetings/prep-notes/foo.md')).toBe('meetings/prep-notes');
  });

  test('returns empty for a top-level file', () => {
    expect(parentFolderOf('foo.md')).toBe('');
  });
});

describe('nestedOkPath', () => {
  test('joins folder + .gitquire + member', () => {
    expect(nestedOkPath('/proj', 'meetings', 'frontmatter.yml')).toBe(
      '/proj/meetings/.gitquire/frontmatter.yml',
    );
    expect(nestedOkPath('/proj', 'meetings/prep-notes', 'templates')).toBe(
      '/proj/meetings/prep-notes/.gitquire/templates',
    );
  });

  test('treats empty / "." as project root', () => {
    expect(nestedOkPath('/proj', '', 'frontmatter.yml')).toBe('/proj/.gitquire/frontmatter.yml');
    expect(nestedOkPath('/proj', '.', 'frontmatter.yml')).toBe('/proj/.gitquire/frontmatter.yml');
  });
});
