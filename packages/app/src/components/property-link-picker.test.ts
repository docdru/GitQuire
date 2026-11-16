import { describe, expect, test } from 'vitest';
import { insertLink, linkQueryAt } from './property-link-picker';

describe('linkQueryAt', () => {
  test('finds an open [[ before the caret', () => {
    expect(linkQueryAt('see [[road', 10)).toEqual({ from: 4, to: 10, query: 'road' });
    expect(linkQueryAt('[[', 2)).toEqual({ from: 0, to: 2, query: '' });
  });

  test('ignores a closed link, a heading or alias part, and text after the caret', () => {
    expect(linkQueryAt('[[a]] next', 10)).toBeNull();
    expect(linkQueryAt('[[a#h', 5)).toBeNull();
    expect(linkQueryAt('[[a|b', 5)).toBeNull();
    expect(linkQueryAt('x [[ab', 3)).toBeNull();
  });
});

describe('insertLink', () => {
  test('replaces the typed part with a closed link and puts the caret after it', () => {
    const text = 'see [[ro and more';
    expect(insertLink(text, { from: 4, to: 8, query: 'ro' }, 'plans/roadmap')).toEqual({
      text: 'see [[plans/roadmap]] and more',
      caret: 21,
    });
  });

  test('does not double closing brackets that are already there', () => {
    expect(insertLink('[[ro]]', { from: 0, to: 4, query: 'ro' }, 'roadmap').text).toBe(
      '[[roadmap]]',
    );
  });
});
