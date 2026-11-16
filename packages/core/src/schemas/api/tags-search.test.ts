import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  canonicalTemplateName,
  classifySemanticProviderError,
  findTemplateByName,
  normalizeApiWarnings,
  SearchSemanticStatusSchema,
  SearchSuccessSchema,
  SemanticIndexStatusSchema,
  semanticProviderErrorBlocks,
  TEMPLATE_NAME_REGEX,
  TemplateGetSuccessSchema,
  TemplatePayloadSchema,
  templateRenameTarget,
} from './tags-search.ts';

const validPayload = (scope: 'local' | 'inherited') => ({
  name: 'daily-journal',
  folder: 'notes',
  scope,
  path: 'notes/.gitquire/templates/daily-journal.md',
  frontmatter: { title: '{{date}}' },
  body: '## Morning\n',
});

describe('semantic provider error classification', () => {
  test.each([
    ['dimensions', 'restart_required'],
    ['configured_dimensions', 'incapable'],
    ['warm', 'provider_error'],
    ['corpus', 'provider_error'],
    ['query', 'provider_error'],
  ] as const)('%s maps to %s', (providerErrorReason, expected) => {
    expect(classifySemanticProviderError({ providerErrorReason })).toBe(expected);
  });

  test('keeps compatibility with an older status that only carries the boolean', () => {
    expect(classifySemanticProviderError({ providerError: true })).toBe('provider_error');
    expect(classifySemanticProviderError({ providerError: false })).toBeNull();
  });

  test.each([
    ['warm', true, true],
    ['corpus', false, false],
    ['query', false, true],
    ['dimensions', true, true],
    ['configured_dimensions', true, true],
  ] as const)('%s blocks probe=%s query=%s', (providerErrorReason, probe, query) => {
    const status = { providerError: true, providerErrorReason };
    expect(semanticProviderErrorBlocks(status, 'probe')).toBe(probe);
    expect(semanticProviderErrorBlocks(status, 'query')).toBe(query);
  });

  test('unknown provider reasons degrade to a generic provider error', () => {
    const indexStatus = SemanticIndexStatusSchema.parse({
      enabled: true,
      keyPresent: true,
      keyNotRequired: false,
      keySource: 'file',
      keyHint: 'a1b2',
      ready: true,
      capable: false,
      providerError: true,
      providerErrorReason: 'future_reason',
      embedded: 0,
      total: 2,
    });
    const searchStatus = SearchSemanticStatusSchema.parse({
      capable: false,
      applied: false,
      outcome: 'provider_error',
      providerErrorReason: 'future_reason',
      coverage: { embedded: 0, total: 2 },
    });

    expect(indexStatus.providerErrorReason).toBeNull();
    expect(classifySemanticProviderError(indexStatus)).toBe('provider_error');
    expect(searchStatus.providerErrorReason).toBeNull();
  });
});

describe('API warning compatibility', () => {
  test('absent warnings remain compatible with older servers', () => {
    expect(normalizeApiWarnings(undefined)).toEqual([]);
    expect(normalizeApiWarnings([])).toEqual([]);
  });

  test.each([null, 'warning', { warning: 'recovery copy deleted' }, [null]])(
    'malformed present warnings remain visibly unverified: %j',
    (value) => {
      expect(normalizeApiWarnings(value).join(' ')).toContain('treat this result as unverified');
    },
  );

  test('unreadable entries do not erase readable warnings', () => {
    const warnings = normalizeApiWarnings(['A recovery copy was deleted.', null]);
    expect(warnings[0]).toBe('A recovery copy was deleted.');
    expect(warnings[1]).toContain('treat this result as unverified');
    expect(normalizeApiWarnings(['A recovery copy was deleted.'])).toEqual([warnings[0]]);
  });
});

describe('TemplatePayloadSchema.scope', () => {
  test.each(['local', 'inherited'] as const)('accepts scope=%s', (scope) => {
    const result = TemplatePayloadSchema.safeParse(validPayload(scope));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe(scope);
    }
  });

  test('rejects unknown scope value', () => {
    const result = TemplatePayloadSchema.safeParse({
      ...validPayload('local'),
      scope: 'global',
    });
    expect(result.success).toBe(false);
  });

  test("rejects scope='user' (user-tier removed)", () => {
    const result = TemplatePayloadSchema.safeParse({
      ...validPayload('local'),
      scope: 'user',
    });
    expect(result.success).toBe(false);
  });
});

describe('TemplateGetSuccessSchema', () => {
  test('frontmatter accepts free-form unknown values', () => {
    const result = TemplateGetSuccessSchema.safeParse({
      template: {
        ...validPayload('local'),
        frontmatter: { title: { '{ date }': null }, tags: ['x'] },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('TEMPLATE_NAME_REGEX', () => {
  test.each([
    'daily-journal',
    'Weekly_1',
    '議事録',
    'café',
    'cafe\u0301',
    'notas-reunión',
    'заметки_1',
    'ملاحظات',
    'मीटिंग-नोट्स',
    '회의록',
  ])('accepts %s', (name) => {
    expect(TEMPLATE_NAME_REGEX.test(name)).toBe(true);
  });

  test.each([
    '',
    'a b',
    'a.b',
    'a/b',
    'a\\b',
    'a:b',
    'a*b',
    'a?b',
    'a"b',
    'a<b',
    'a|b',
    'notes.md',
    'a\u200bb',
    'a\u3164b',
    'a\u034fb',
    '\u115f',
  ])('rejects %j', (name) => {
    expect(TEMPLATE_NAME_REGEX.test(name)).toBe(false);
  });
});

describe('canonicalTemplateName', () => {
  test('a decomposed name becomes its composed spelling', () => {
    expect(canonicalTemplateName('cafe\u0301')).toBe('café');
    expect(canonicalTemplateName('\u30C6\u3099\u30FC\u30BF')).toBe('データ');
  });

  test('an already composed or ASCII name is unchanged', () => {
    expect(canonicalTemplateName('café')).toBe('café');
    expect(canonicalTemplateName('daily-journal')).toBe('daily-journal');
  });
});

describe('findTemplateByName', () => {
  const composed = { name: 'caf\u{00E9}' };
  const decomposed = { name: 'cafe\u{0301}' };

  test('a composed request finds a listed decomposed template', () => {
    expect(findTemplateByName([decomposed], 'caf\u{00E9}')).toBe(decomposed);
  });

  test('a decomposed request finds a listed composed template', () => {
    expect(findTemplateByName([composed], 'cafe\u{0301}')).toBe(composed);
  });

  test('an exact spelling wins over another spelling of the same name', () => {
    expect(findTemplateByName([composed, decomposed], 'cafe\u{0301}')).toBe(decomposed);
    expect(findTemplateByName([decomposed, composed], 'caf\u{00E9}')).toBe(composed);
  });

  test('a different name finds nothing', () => {
    expect(findTemplateByName([composed], 'cafe')).toBeUndefined();
  });
});

describe('templateRenameTarget', () => {
  test('an unedited name, in any spelling, is not a rename', () => {
    expect(templateRenameTarget('cafe\u{0301}', 'cafe\u{0301}')).toBeNull();
    expect(templateRenameTarget('caf\u{00E9}', 'caf\u{00E9}')).toBeNull();
    expect(templateRenameTarget('meeting', '  meeting ')).toBeNull();
  });

  test('re-entering a composed name in decomposed form is not a rename', () => {
    expect(templateRenameTarget('caf\u{00E9}', 'cafe\u{0301}')).toBeNull();
  });

  test('a new name is a rename to its composed spelling', () => {
    expect(templateRenameTarget('meeting', 'cafe\u{0301}')).toBe('caf\u{00E9}');
    expect(templateRenameTarget('meeting', ' standup ')).toBe('standup');
  });

  test('a decomposed name can be renamed to its composed spelling', () => {
    expect(templateRenameTarget('cafe\u{0301}', 'caf\u{00E9}')).toBe('caf\u{00E9}');
  });
});

describe('SearchSuccessSchema under zod/compile', () => {
  test('compiles as a whole schema in strict mode', () => {
    expect(() => z.compile(SearchSuccessSchema, { strict: true })).not.toThrow();
  });
});
