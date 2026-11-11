import { describe, expect, test } from 'vitest';
import { applyNamingRule, parseNamingRule, slugifySegment, titleSeed } from './naming.ts';

describe('naming rule', () => {
  test('defaults to slug and can be turned off', () => {
    expect(parseNamingRule(undefined)).toBe('slug');
    expect(parseNamingRule(' OFF ')).toBe('off');
    expect(parseNamingRule('kebab')).toBe('slug');
  });

  test('slugifies names and keeps short extensions', () => {
    expect(slugifySegment('Meeting Notes 2026.MD', true)).toBe('meeting-notes-2026.md');
    expect(slugifySegment('Q3 Report – Draft!.md', true)).toBe('q3-report-draft.md');
    expect(slugifySegment('Größe & Maße.md', true)).toBe('große-maße.md');
    expect(slugifySegment('v1.2 notes', true)).toBe('v1-2-notes');
    expect(slugifySegment('Project Plans', false)).toBe('project-plans');
  });

  test('leaves hidden, underscore and unsluggable segments alone', () => {
    expect(slugifySegment('.ok', false)).toBe('.ok');
    expect(slugifySegment('_Drafts', false)).toBe('_Drafts');
    expect(slugifySegment('🚀.md', true)).toBe('🚀.md');
  });

  test('keeps existing folders and names new ones', () => {
    const existing = new Set(['Old Folder']);
    const named = applyNamingRule('Old Folder/New Area/First Page.md', {
      rule: 'slug',
      lastIsFile: true,
      keepFolder: (folder) => existing.has(folder),
    });
    expect(named).toBe('Old Folder/new-area/first-page.md');
    expect(applyNamingRule('A B/', { rule: 'slug', lastIsFile: false })).toBe('a-b/');
    expect(applyNamingRule('A B.md', { rule: 'off', lastIsFile: true })).toBe('A B.md');
  });

  test('seeds a readable title only when the name changed', () => {
    expect(titleSeed('notes/Meeting Notes.md', 'notes/meeting-notes.md')).toBe('# Meeting Notes\n');
    expect(titleSeed('notes/meeting-notes.md', 'notes/meeting-notes.md')).toBe('');
  });
});
