import { describe, expect, test } from 'vitest';
import {
  resolveActiveTargetAbsPath,
  resolveActiveTargetRelativePath,
} from './file-menu-target-resolvers';
import type { Workspace } from './workspace-paths';

const WORKSPACE: Workspace = {
  contentDir: '/Users/test/project',
  pathSeparator: '/',
};

describe('resolveActiveTargetAbsPath', () => {
  test('doc scope joins contentDir + markdown relative path', () => {
    expect(
      resolveActiveTargetAbsPath(
        { kind: 'doc', target: 'specs/foo', docName: 'specs/foo' },
        WORKSPACE,
      ),
    ).toBe('/Users/test/project/specs/foo.md');
  });

  test('folder-index scope routes through the doc path (folder note is a doc)', () => {
    expect(
      resolveActiveTargetAbsPath(
        {
          kind: 'folder-index',
          target: 'specs',
          folderPath: 'specs',
          docName: 'specs/index',
          noteKind: 'canonical-index',
        },
        WORKSPACE,
      ),
    ).toBe('/Users/test/project/specs/index.md');
  });

  test('extension-qualified doc scope uses active target docName', () => {
    expect(
      resolveActiveTargetAbsPath(
        { kind: 'doc', target: 'specs/foo.mdx', docName: 'specs/foo.mdx' },
        WORKSPACE,
      ),
    ).toBe('/Users/test/project/specs/foo.mdx');
  });

  test('folder scope joins contentDir + folderPath (no trailing slash)', () => {
    expect(
      resolveActiveTargetAbsPath(
        { kind: 'folder', target: 'reports', folderPath: 'reports' },
        WORKSPACE,
      ),
    ).toBe('/Users/test/project/reports');
  });

  test('null scope (project) returns contentDir verbatim', () => {
    expect(resolveActiveTargetAbsPath(null, WORKSPACE)).toBe('/Users/test/project');
  });

  test('asset scope joins contentDir + assetPath', () => {
    expect(
      resolveActiveTargetAbsPath(
        { kind: 'asset', target: 'media/foo.png', assetPath: 'media/foo.png', mediaKind: null },
        WORKSPACE,
      ),
    ).toBe('/Users/test/project/media/foo.png');
  });

  test('missing scope falls back to contentDir', () => {
    expect(resolveActiveTargetAbsPath({ kind: 'missing', target: 'gone' }, WORKSPACE)).toBe(
      '/Users/test/project',
    );
  });
});

describe('resolveActiveTargetRelativePath', () => {
  test('doc scope returns markdown relative path', () => {
    expect(
      resolveActiveTargetRelativePath({ kind: 'doc', target: 'specs/foo', docName: 'specs/foo' }),
    ).toBe('specs/foo.md');
  });

  test('folder-index scope returns the doc-relative path', () => {
    expect(
      resolveActiveTargetRelativePath({
        kind: 'folder-index',
        target: 'specs',
        folderPath: 'specs',
        docName: 'specs/index',
        noteKind: 'canonical-index',
      }),
    ).toBe('specs/index.md');
  });

  test('extension-qualified doc scope returns active target relative path', () => {
    expect(
      resolveActiveTargetRelativePath({
        kind: 'doc',
        target: 'specs/foo.mdx',
        docName: 'specs/foo.mdx',
      }),
    ).toBe('specs/foo.mdx');
  });

  test('folder scope returns the folder path with no trailing slash', () => {
    expect(
      resolveActiveTargetRelativePath({ kind: 'folder', target: 'reports', folderPath: 'reports' }),
    ).toBe('reports');
  });

  test('asset scope returns the asset-relative path', () => {
    expect(
      resolveActiveTargetRelativePath({
        kind: 'asset',
        target: 'x.png',
        assetPath: 'x.png',
        mediaKind: null,
      }),
    ).toBe('x.png');
  });

  test('null / missing scopes return empty string (contentDir convention)', () => {
    expect(resolveActiveTargetRelativePath(null)).toBe('');
    expect(resolveActiveTargetRelativePath({ kind: 'missing', target: 'gone' })).toBe('');
  });
});
