import { describe, expect, test } from 'vitest';
import { createdRenameSource, withTreeExtension } from './pending-rename';

describe('createdRenameSource', () => {
  const file = { kind: 'file' as const, renamePath: 'Untitled.md', createdPath: 'untitled' };
  const folder = {
    kind: 'folder' as const,
    renamePath: 'notes/New Folder/',
    createdPath: 'notes/new-folder',
  };

  test('renames a just-created file from the name the server gave it', () => {
    expect(createdRenameSource(file, 'Untitled.md', false)).toBe('untitled');
  });

  test('renames a just-created folder from the name the server gave it', () => {
    expect(createdRenameSource(folder, 'notes/New Folder/', true)).toBe('notes/new-folder');
  });

  test('leaves other renames alone', () => {
    expect(createdRenameSource(null, 'Untitled.md', false)).toBeUndefined();
    expect(createdRenameSource(file, 'Other.md', false)).toBeUndefined();
    expect(createdRenameSource(file, 'Untitled.md', true)).toBeUndefined();
  });
});

describe('withTreeExtension', () => {
  test('adds the extension shown in the tree', () => {
    expect(withTreeExtension('untitled', 'Untitled.md')).toBe('untitled.md');
    expect(withTreeExtension('notes/untitled', 'notes/Untitled.mdx')).toBe('notes/untitled.mdx');
    expect(withTreeExtension('untitled', 'Untitled')).toBe('untitled');
  });
});
