import { describe, expect, test } from 'vitest';
import { linkRowLocation, snippetAddsContext } from './link-row';

describe('linkRowLocation', () => {
  test('shows the folder of a page and nothing for a top-level page', () => {
    expect(linkRowLocation('project-atlas/kick-off-meeting')).toBe('project-atlas');
    expect(linkRowLocation('a/b/c')).toBe('a/b');
    expect(linkRowLocation('readme')).toBeUndefined();
    expect(linkRowLocation(undefined)).toBeUndefined();
  });

  test('keeps a web address whole', () => {
    expect(linkRowLocation('https://example.com/a/b')).toBe('https://example.com/a/b');
  });
});

describe('snippetAddsContext', () => {
  const mentions = ['Kick-off meeting', 'project-atlas/kick-off-meeting', 'supersedes'];

  test('hides a snippet that only repeats the link and its relation', () => {
    expect(snippetAddsContext('supersedes:: project-atlas/kick-off-meeting', mentions)).toBe(false);
    expect(snippetAddsContext('Kick-off meeting', mentions)).toBe(false);
    expect(snippetAddsContext(null, mentions)).toBe(false);
  });

  test('keeps a snippet with surrounding words', () => {
    expect(snippetAddsContext('Agenda for the kick-off-meeting with Anna', mentions)).toBe(true);
  });
});
