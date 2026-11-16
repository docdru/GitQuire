import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-gq-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'cst-pm-handler-todo-stub';
const CODE = `gq(${RULE})`;
const FIXTURE = `lint-plugins/gq-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/gq-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 4 codemod stubs, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual(['23:3', '28:3', '33:3', '38:3']);
    for (const fire of found) {
      expect(fire.message).toContain('Codemod-emitted handler stub still throws TODO marker');
      expect(fire.message).toContain('fill in the substrate-specific body');
      expect(fire.message).toContain('ICstEngine');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`gq/${RULE}`);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      ['packages/md-conformance/src/substrates/*/handlers/**/*.ts', FIXTURE].sort(),
    );
  });
});
