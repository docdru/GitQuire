import { describe, expect, test } from 'vitest';
import {
  frontmatterRelationLinks,
  inlineRelationFields,
  inlineRelationLinks,
  normalizeRelation,
  relationLinks,
} from './typed-links.ts';

describe('normalizeRelation', () => {
  test('trims, lowercases and collapses spaces', () => {
    expect(normalizeRelation('  Blocked   By ')).toBe('blocked by');
    expect(normalizeRelation('**Supersedes**')).toBe('supersedes');
    expect(normalizeRelation('part-of')).toBe('part-of');
  });

  test('rejects names that cannot be relations', () => {
    expect(normalizeRelation('')).toBeUndefined();
    expect(normalizeRelation('-leading')).toBeUndefined();
    expect(normalizeRelation('has [brackets]')).toBeUndefined();
    expect(normalizeRelation('x'.repeat(61))).toBeUndefined();
  });
});

describe('inlineRelationFields', () => {
  test('reads a field that fills the line', () => {
    expect(inlineRelationFields('blocks:: [[Task B]]')).toEqual([
      { relation: 'blocks', value: '[[Task B]]', valueStart: 9 },
    ]);
  });

  test('reads a field in a list item or quote', () => {
    expect(inlineRelationFields('- **Depends on**:: [[Setup]]')[0]?.relation).toBe('depends on');
    expect(inlineRelationFields('> part of:: [[Roadmap]]')[0]?.relation).toBe('part of');
    expect(inlineRelationFields('- [ ] blocks:: [[Task B]]')[0]?.relation).toBe('blocks');
  });

  test('reads bracketed fields inside a sentence', () => {
    const fields = inlineRelationFields(
      'We agreed [supersedes:: [[Decision 9]]] and (relates to:: [[Budget]]).',
    );
    expect(fields.map((field) => [field.relation, field.value])).toEqual([
      ['supersedes', '[[Decision 9]]'],
      ['relates to', '[[Budget]]'],
    ]);
  });

  test('ignores plain links, single colons and triple colons', () => {
    expect(inlineRelationFields('See [[Task B]].')).toEqual([]);
    expect(inlineRelationFields('note: [[Task B]]')).toEqual([]);
    expect(inlineRelationFields('a::: [[Task B]]')).toEqual([]);
  });
});

describe('inlineRelationLinks', () => {
  test('returns typed links with file line numbers', () => {
    const markdown = [
      '---',
      'title: Task A',
      '---',
      '',
      'blocks:: [[Task B]], [[Task C#Plan|the plan]]',
      'Plain [[Elsewhere]] link.',
    ].join('\n');
    expect(inlineRelationLinks(markdown)).toEqual([
      { relation: 'blocks', target: 'Task B', anchor: null, origin: 'inline', line: 4 },
      { relation: 'blocks', target: 'Task C', anchor: 'Plan', origin: 'inline', line: 4 },
    ]);
  });

  test('skips code fences, embeds and external targets', () => {
    const markdown = [
      '```',
      'blocks:: [[In Code]]',
      '```',
      'shows:: ![[Diagram]]',
      'source:: [[https://example.com]]',
    ].join('\n');
    expect(inlineRelationLinks(markdown)).toEqual([]);
  });

  test('skips the comment trailer', () => {
    const markdown = [
      'Body',
      '',
      '<!-- gitquire-comments v1',
      'blocks:: [[Hidden]]',
      '-->',
      '',
    ].join('\n');
    expect(inlineRelationLinks(markdown)).toEqual([]);
  });
});

describe('frontmatterRelationLinks', () => {
  test('reads quoted, list and unquoted link values', () => {
    const markdown = [
      '---',
      'title: Decision 14',
      'supersedes: "[[Decision 9]]"',
      'related:',
      '  - "[[Budget]]"',
      '  - [[Roadmap]]',
      'owner: [[Alice|A.]]',
      'status: open',
      '---',
      'Body',
    ].join('\n');
    expect(frontmatterRelationLinks(markdown)).toEqual([
      {
        relation: 'supersedes',
        target: 'Decision 9',
        anchor: null,
        origin: 'frontmatter',
        line: 2,
      },
      { relation: 'related', target: 'Budget', anchor: null, origin: 'frontmatter', line: 3 },
      { relation: 'related', target: 'Roadmap', anchor: null, origin: 'frontmatter', line: 3 },
      { relation: 'owner', target: 'Alice', anchor: null, origin: 'frontmatter', line: 6 },
    ]);
  });

  test('returns nothing without frontmatter or with broken YAML', () => {
    expect(frontmatterRelationLinks('Body [[A]]')).toEqual([]);
    expect(frontmatterRelationLinks('---\nbad: [\n---\n')).toEqual([]);
  });
});

describe('relationLinks', () => {
  test('combines both forms and drops duplicates', () => {
    const markdown = [
      '---',
      'supersedes: "[[Decision 9]]"',
      '---',
      'supersedes:: [[Decision 9]]',
      'supersedes:: [[Decision 9]]',
    ].join('\n');
    expect(relationLinks(markdown).map((link) => [link.origin, link.line])).toEqual([
      ['frontmatter', 1],
      ['inline', 3],
    ]);
  });
});
