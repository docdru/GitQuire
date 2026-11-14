import { describe, expect, test } from 'vitest';
import {
  fetchPeople,
  insertMention,
  knownLogins,
  matchPeople,
  mentionQueryAt,
  type Person,
  personLabel,
} from './people';

const PEOPLE: Person[] = [
  { login: 'alice', name: 'Alice Archer' },
  { login: 'bob-b', name: 'Robert Brown' },
  { login: 'carol' },
];

describe('mentionQueryAt', () => {
  test('finds the @ word right before the caret', () => {
    expect(mentionQueryAt('hi @al', 6)).toEqual({ start: 3, query: 'al' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('(@bo', 4)).toEqual({ start: 1, query: 'bo' });
  });

  test('ignores e-mail addresses, finished words and text after the caret', () => {
    expect(mentionQueryAt('mail me@example', 15)).toBeNull();
    expect(mentionQueryAt('@alice done', 11)).toBeNull();
    expect(mentionQueryAt('@al rest', 8)).toBeNull();
  });
});

describe('matchPeople', () => {
  test('ranks login prefixes, then name words, then other matches', () => {
    expect(matchPeople(PEOPLE, 'b').map((p) => p.login)).toEqual(['bob-b']);
    expect(matchPeople(PEOPLE, 'rob').map((p) => p.login)).toEqual(['bob-b']);
    expect(matchPeople(PEOPLE, 'ar').map((p) => p.login)).toEqual(['alice', 'carol']);
    expect(matchPeople(PEOPLE, '').map((p) => p.login)).toEqual(['alice', 'bob-b', 'carol']);
  });

  test('limits the number of suggestions', () => {
    expect(matchPeople(PEOPLE, '', 2)).toHaveLength(2);
  });
});

describe('insertMention', () => {
  test('replaces the typed word with the login and a space', () => {
    expect(insertMention('hi @al', 3, 6, 'alice')).toEqual({ text: 'hi @alice ', caret: 10 });
  });

  test('reuses a following space', () => {
    expect(insertMention('@al and', 0, 3, 'alice')).toEqual({ text: '@alice and', caret: 7 });
  });
});

describe('helpers', () => {
  test('known logins are case-insensitive and labels show the name', () => {
    expect(knownLogins(PEOPLE).has('alice')).toBe(true);
    expect(personLabel(PEOPLE[0] as Person)).toBe('Alice Archer (@alice)');
    expect(personLabel({ login: 'carol' })).toBe('@carol');
  });
});

describe('fetchPeople', () => {
  test('reads people and the signed-in login', async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ people: [{ login: 'alice', name: 'Alice' }, { name: 'x' }], me: 'alice' }),
        { headers: { 'content-type': 'application/json' } },
      );
    expect(await fetchPeople(fetchFn as unknown as typeof fetch)).toEqual({
      loaded: true,
      people: [{ login: 'alice', name: 'Alice' }],
      me: 'alice',
    });
  });

  test('is empty without sign-in or on errors', async () => {
    const failing = async () => {
      throw new TypeError('offline');
    };
    expect(await fetchPeople(failing as unknown as typeof fetch)).toEqual({
      loaded: true,
      people: [],
      me: null,
    });
  });
});
