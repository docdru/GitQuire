import { describe, expect, test } from 'vitest';
import {
  type InlinePiece,
  isValidRelationInput,
  relationEdits,
  relationFieldsInInline,
  relationOfLink,
} from './relation-fields';

const text = (value: string): InlinePiece => ({ kind: 'text', text: value, size: value.length });
const link: InlinePiece = { kind: 'wikiLink', text: '', size: 1 };
const lineBreak: InlinePiece = { kind: 'break', text: '', size: 1 };

describe('relationFieldsInInline', () => {
  test('finds a field that starts the paragraph', () => {
    const fields = relationFieldsInInline([text('supersedes:: '), link], 1);
    expect(fields).toEqual([
      {
        relation: 'supersedes',
        form: 'line',
        from: 1,
        nameFrom: 1,
        nameTo: 11,
        valueFrom: 14,
        to: 15,
        linkPositions: [14],
      },
    ]);
  });

  test('finds a bracketed field inside a sentence', () => {
    const fields = relationFieldsInInline([text('We agreed (blocks:: '), link, text(') today')], 0);
    expect(fields).toEqual([
      {
        relation: 'blocks',
        form: 'bracket',
        from: 10,
        nameFrom: 11,
        nameTo: 17,
        valueFrom: 20,
        to: 22,
        linkPositions: [20],
      },
    ]);
  });

  test('gives every link on a field line the relation', () => {
    const fields = relationFieldsInInline([text('depends on:: '), link, text(', '), link], 0);
    expect(fields[0]?.linkPositions).toEqual([13, 16]);
  });

  test('finds a field after a line break', () => {
    const fields = relationFieldsInInline([text('Intro'), lineBreak, text('blocks:: '), link], 0);
    expect(fields[0]).toMatchObject({ relation: 'blocks', from: 6, valueFrom: 15 });
  });

  test('ignores fields without a link and fields in code', () => {
    expect(relationFieldsInInline([text('note:: plain text')], 0)).toEqual([]);
    expect(relationFieldsInInline([{ kind: 'code', text: 'blocks:: ', size: 9 }, link], 0)).toEqual(
      [],
    );
  });
});

describe('relationOfLink', () => {
  test('reads the relation of one link', () => {
    const pieces = [text('See '), link, text(' and (blocks:: '), link, text(')')];
    expect(relationOfLink(pieces, 0, 4)).toBeNull();
    expect(relationOfLink(pieces, 0, 20)).toBe('blocks');
  });
});

describe('relationEdits', () => {
  test('adds a field line when the link starts the paragraph', () => {
    expect(relationEdits([link], 1, 1, 'Supersedes')).toEqual([
      { from: 1, to: 1, insert: 'supersedes:: ' },
    ]);
  });

  test('wraps a link inside a sentence in round brackets', () => {
    expect(relationEdits([text('See '), link, text('.')], 0, 4, 'blocks')).toEqual([
      { from: 5, to: 5, insert: ')' },
      { from: 4, to: 4, insert: '(blocks:: ' },
    ]);
  });

  test('renames an existing relation', () => {
    expect(relationEdits([text('blocks:: '), link], 0, 9, 'depends on')).toEqual([
      { from: 0, to: 6, insert: 'depends on' },
    ]);
  });

  test('removes a field line or a bracketed field', () => {
    expect(relationEdits([text('blocks:: '), link], 0, 9, null)).toEqual([
      { from: 0, to: 9, insert: '' },
    ]);
    expect(relationEdits([text('See (blocks:: '), link, text(')')], 0, 14, '')).toEqual([
      { from: 15, to: 16, insert: '' },
      { from: 4, to: 14, insert: '' },
    ]);
  });

  test('changes nothing for the same or an invalid name', () => {
    expect(relationEdits([text('blocks:: '), link], 0, 9, 'Blocks')).toEqual([]);
    expect(relationEdits([link], 0, 0, '[bad]')).toEqual([]);
    expect(relationEdits([link], 0, 0, null)).toEqual([]);
  });
});

describe('isValidRelationInput', () => {
  test('accepts empty input and relation names', () => {
    expect(isValidRelationInput('')).toBe(true);
    expect(isValidRelationInput('relates to')).toBe(true);
    expect(isValidRelationInput('[bad]')).toBe(false);
  });
});
