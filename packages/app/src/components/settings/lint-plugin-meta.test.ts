import { LINT_PLUGINS } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { LINT_PLUGIN_META } from './lint-plugin-meta.ts';

describe('LINT_PLUGIN_META ⟷ plugin registry', () => {
  test('covers exactly the registered plugin ids (settings list stays in sync)', () => {
    expect(LINT_PLUGIN_META.map((meta) => meta.id).sort()).toEqual(
      LINT_PLUGINS.map((plugin) => plugin.id).sort(),
    );
  });

  test('every entry has a non-empty label', () => {
    for (const meta of LINT_PLUGIN_META) {
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });
});
