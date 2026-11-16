const GQ_RULES_DIR = 'lint-plugins/gq-rules';
export const GQ_RULES_TESTS_DIR = `${GQ_RULES_DIR}/tests`;
export const GQ_RULES_FIXTURES_DIR = `${GQ_RULES_DIR}/__fixtures__`;

export const ROUND_READS = {
  test: './gq-rules-scope-partition.uncached.test.mjs',
  reads: 'the gq-rules registry, scope table, rules, fixtures and tests it partitions, and the oxlint config that loads the plugin',
  include: [`${GQ_RULES_DIR}/**`, 'oxlint.config.ts'],
};
