import type { LintPluginId } from '@gitquire/core/markdown/lint';

export interface LintPluginMeta {
  id: LintPluginId;
  label: string;
  docUrl: string;
  beta?: boolean;
}

const DOCS_BASE = 'https://docdru.github.io/GitQuire/docs/advanced/content-rules';

export const LINT_PLUGIN_META: LintPluginMeta[] = [
  { id: 'markdownlint', label: 'markdownlint', docUrl: `${DOCS_BASE}/markdownlint` },
  {
    id: 'frontmatter',
    // oxlint-disable-next-line ok/no-unwrapped-user-facing-string -- names the frontmatter plugin, and `frontmatter` is a GLOSSARY never-translate term — this label is the plugin's name beside `markdownlint`, not copy.
    label: 'Frontmatter schemas',
    docUrl: `${DOCS_BASE}/frontmatter`,
  },
  {
    id: 'okf',
    label: 'OKF',
    docUrl: 'https://docdru.github.io/GitQuire/docs/plugins/okf',
    beta: true,
  },
];
