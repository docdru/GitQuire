import { describe, expect, test } from 'vitest';
import { nameLastSegment } from './naming';

describe('nameLastSegment', () => {
  test('names only the segment being typed', () => {
    expect(nameLastSegment('Old Folder/Kick Off.md', true, 'slug')).toBe('Old Folder/kick-off.md');
    expect(nameLastSegment('notes/New Area/', false, 'slug')).toBe('notes/new-area/');
    expect(nameLastSegment('Kick Off.md', true, 'off')).toBe('Kick Off.md');
  });
});
