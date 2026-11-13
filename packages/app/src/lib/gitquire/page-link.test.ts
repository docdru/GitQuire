import { describe, expect, test } from 'vitest';
import { gitquirePageLink } from './page-link';

const location = { origin: 'https://wiki.example.com', pathname: '/' };

describe('gitquirePageLink', () => {
  test('links a page on this server', () => {
    expect(gitquirePageLink({ kind: 'doc', docName: 'project-atlas/kick-off' }, location)).toBe(
      'https://wiki.example.com/#/project-atlas/kick-off',
    );
  });

  test('links a folder overview', () => {
    expect(
      gitquirePageLink({ kind: 'folder', folderRelativePath: 'project-atlas' }, location),
    ).toBe('https://wiki.example.com/#/project-atlas/');
  });

  test('keeps a sub-path the server is mounted under', () => {
    const mounted = { origin: 'https://example.com', pathname: '/wiki/' };
    expect(gitquirePageLink({ kind: 'doc', docName: 'readme' }, mounted)).toBe(
      'https://example.com/wiki/#/readme',
    );
  });
});
