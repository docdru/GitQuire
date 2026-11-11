import { describe, expect, test } from 'vitest';
import { aliasFromSelection, linkAttrsFor, linkPickerItems, linkPlacement } from './link-picker';

const pages = [
  { docName: 'notes/Quarterly report', title: 'Quarterly report' },
  { docName: 'plan', title: '' },
];

const report = {
  kind: 'page',
  docName: 'notes/Quarterly report',
  title: 'Quarterly report',
  folder: 'notes',
} as const;

describe('linkPickerItems', () => {
  test('lists pages with a title and their folder', () => {
    expect(linkPickerItems(pages, '')).toEqual([
      report,
      { kind: 'page', docName: 'plan', title: 'plan', folder: '' },
    ]);
  });

  test('offers a new page only when no page has that name', () => {
    expect(linkPickerItems(pages, ' Budget ').at(-1)).toEqual({ kind: 'create', title: 'Budget' });
    expect(linkPickerItems(pages, 'quarterly REPORT')).toHaveLength(2);
    expect(linkPickerItems(pages, 'Plan')).toHaveLength(2);
    expect(linkPickerItems(pages, 'Quarterly Report!')).toHaveLength(2);
    expect(linkPickerItems([], '   ')).toEqual([]);
  });
});

describe('linkAttrsFor', () => {
  test('links to the page and keeps selected text as the label', () => {
    expect(linkAttrsFor(report, '')).toEqual({
      target: 'notes/Quarterly report',
      alias: null,
      anchor: null,
    });
    expect(linkAttrsFor(report, 'the  numbers\n')).toEqual({
      target: 'notes/Quarterly report',
      alias: 'the numbers',
      anchor: null,
    });
    expect(linkAttrsFor(report, 'Quarterly report')?.alias).toBe('Quarterly report');
    expect(linkAttrsFor(report, 'notes/Quarterly report')?.alias).toBeNull();
  });

  test('links to a page that does not exist yet', () => {
    const attrs = linkAttrsFor({ kind: 'create', title: 'Budget' }, '');
    expect(attrs?.target).not.toBe('');
    expect(attrs?.anchor).toBeNull();
    expect(linkAttrsFor({ kind: 'create', title: 'Budget' }, 'see here')?.alias).toBe('see here');
  });
});

describe('aliasFromSelection', () => {
  test('drops text that would break the link syntax or is too long', () => {
    expect(aliasFromSelection('a | b')).toBeNull();
    expect(aliasFromSelection('see [this]')).toBeNull();
    expect(aliasFromSelection('x'.repeat(201))).toBeNull();
    expect(aliasFromSelection('  fine  ')).toBe('fine');
  });
});

describe('linkPlacement', () => {
  test('replaces the selection only while it is still the text that was selected', () => {
    const same = { from: 5, to: 12, text: 'numbers', withinOneBlock: true };
    expect(linkPlacement('numbers', same)).toEqual({ from: 5, to: 12, text: 'numbers' });
    const shifted = { from: 5, to: 12, text: 'umbers ', withinOneBlock: true };
    expect(linkPlacement('numbers', shifted)).toEqual({ from: 12, to: 12, text: '' });
    const acrossBlocks = { from: 5, to: 40, text: 'numbers', withinOneBlock: false };
    expect(linkPlacement('numbers', acrossBlocks)).toEqual({ from: 40, to: 40, text: '' });
    const cursor = { from: 7, to: 7, text: '', withinOneBlock: true };
    expect(linkPlacement('', cursor)).toEqual({ from: 7, to: 7, text: '' });
  });
});
