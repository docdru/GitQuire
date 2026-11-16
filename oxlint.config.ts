import { defineConfig } from 'oxlint';

const restrictedSyntax = [
  {
    selector:
      "CallExpression[callee.name='useEffect'] UnaryExpression[operator='typeof'] > Identifier[name='window']",
    message:
      "Do not use `typeof window !== 'undefined'` inside useEffect; useEffect already runs client-side.",
  },
  {
    selector:
      "CallExpression[callee.name='useLayoutEffect'] UnaryExpression[operator='typeof'] > Identifier[name='window']",
    message:
      "Do not use `typeof window !== 'undefined'` inside useLayoutEffect; useLayoutEffect already runs client-side.",
  },
  {
    selector:
      "CallExpression[callee.object.name='vi'][callee.property.name='doMock'] Literal[value='@/components/ui/tooltip'], CallExpression[callee.object.name='vi'][callee.property.name='mock'] Literal[value='@/components/ui/tooltip']",
    message:
      'Do not mock tooltip primitives. Import TooltipProvider and wrap the rendered component instead.',
  },
];

const noRequireInTests = {
  selector: "CallExpression[callee.name='require'], CallExpression[callee.object.name='require']",
  message:
    'require() is not available in an ESM test module. Use a static import or await import(); for a native/CJS addon use createRequire(import.meta.url) bound to a name other than "require" (e.g. require_).',
};

const NO_COMMENTS_PLUGIN = './lint-plugins/no-comments/plugin.mjs';
const GQ_RULES_PLUGIN = './lint-plugins/gq-rules/index.mjs';
const NO_COMMENTS_RULE = 'no-comments/no-comments';
const NO_COMMENTS_SEVERITY = 'error';

export default defineConfig({
  ignorePatterns: [
    '.agents/skills/**',
    '.codex/skills/**',
    '/reports/**',
    '/specs/**',
    'lint-plugins/no-comments/__fixtures__/**',
    'lint-plugins/gq-rules/__fixtures__/**',
  ],
  options: {
    reportUnusedDisableDirectives: 'error',
    typeAware: true,
  },
  plugins: ['unicorn', 'typescript', 'oxc', 'react', 'jsx-a11y'],
  jsPlugins: [
    { name: 'eslint-js', specifier: 'oxlint-plugin-eslint' },
    { name: 'unicorn-js', specifier: 'eslint-plugin-unicorn' },
    NO_COMMENTS_PLUGIN,
    GQ_RULES_PLUGIN,
  ],
  rules: {
    'gq/class-proof-registration-discipline': 'error',
    'gq/cst-pm-handler-todo-stub': 'error',
    'gq/microcopy-ellipsis': 'error',
    'gq/no-app-core-barrel-import': 'error',
    'gq/no-blind-agent-host-fanout': 'error',
    'gq/no-custom-toast': 'error',
    'gq/no-demoted-dialog-confirm': 'error',
    'gq/no-empty-jsx-expression': 'error',
    'gq/no-fixed-palette-color': 'error',
    'gq/no-hand-rolled-branch-validation': 'error',
    'gq/no-hand-rolled-test-file-suffix': 'error',
    'gq/no-hand-rolled-spinner': 'error',
    'gq/no-inline-tolerance-class': 'error',
    'gq/no-native-renderer-dialog': 'error',
    'gq/no-physical-direction-utility': 'error',
    'gq/no-raw-error-toast': 'error',
    'gq/no-raw-html-interactive-element': 'error',
    'gq/no-raw-route-hash-construction': 'error',
    'gq/no-redundant-jsx-element-braces': 'error',
    'gq/no-resolved-value-theme-source': 'error',
    'gq/no-roundtrip-identity-oracle': 'error',
    'gq/no-sentinel-signal-target': 'error',
    'gq/no-split-suggestion-dispatch': 'error',
    'gq/no-themeless-pierre-diff': 'error',
    'gq/no-unconverted-git-pathspec': 'error',
    'gq/no-unportaled-editor-content': 'error',
    'gq/no-unwrapped-user-facing-string': 'error',
    'gq/path-conditional-map-driven-origin': 'error',
    'gq/playwright-prefer-to-have-count': 'error',
    'gq/require-utf8-multipart-parser': 'error',
    'gq/require-windowshide-on-spawn': 'error',
    [NO_COMMENTS_RULE]: NO_COMMENTS_SEVERITY,
    'eslint/logical-assignment-operators': [
      'error',
      'always',
      {
        enforceForIfStatements: true,
      },
    ],
    'eslint-js/no-restricted-syntax': ['error', ...restrictedSyntax],
    'unicorn-js/prefer-promise-with-resolvers': 'error',
    'react/jsx-curly-brace-presence': [
      'error',
      { children: 'never', props: 'never', propElementValues: 'ignore' },
    ],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'bun:test',
            message: 'Import test APIs directly from vitest.',
          },
        ],
      },
    ],
    'eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    'typescript/no-floating-promises': 'off',
    'eslint/no-unsafe-optional-chaining': 'off',
    'typescript/await-thenable': 'off',
    'typescript/no-implied-eval': 'off',
    'unicorn/no-invalid-fetch-options': 'off',
    'typescript/restrict-template-expressions': 'off',
    'typescript/no-base-to-string': 'off',
    'typescript/unbound-method': 'off',
    'typescript/no-misused-spread': 'off',
    'typescript/no-this-alias': 'off',
    'typescript/no-duplicate-type-constituents': 'off',
    'typescript/no-meaningless-void-operator': 'off',
    'typescript/require-array-sort-compare': 'off',
    'typescript/no-redundant-type-constituents': 'off',
    'unicorn/no-new-array': 'off',
    'eslint/no-shadow-restricted-names': 'off',
    'eslint/no-empty-pattern': 'off',
    'unicorn/no-empty-file': 'off',
    'eslint/no-control-regex': 'off',
    'oxc/erasing-op': 'off',
    'typescript/no-useless-default-assignment': 'off',
    'typescript/prefer-as-const': 'off',
    'react/set-state-in-effect': 'off',
    'react-hooks/exhaustive-deps': 'off',
    'react/refs': 'off',
    'react/globals': 'off',
    'react/static-components': 'off',
    'react/immutability': 'off',
    'jsx-a11y/anchor-ambiguous-text': 'error',
    'jsx-a11y/anchor-is-valid': 'error',
    'jsx-a11y/click-events-have-key-events': 'error',
    'jsx-a11y/no-noninteractive-tabindex': 'error',
    'jsx-a11y/no-static-element-interactions': [
      'error',
      {
        handlers: [
          'onBlur',
          'onClick',
          'onContextMenu',
          'onDblClick',
          'onDoubleClick',
          'onDrag',
          'onDragEnd',
          'onDragEnter',
          'onDragExit',
          'onDragLeave',
          'onDragOver',
          'onDragStart',
          'onDrop',
          'onFocus',
          'onKeyDown',
          'onKeyPress',
          'onKeyUp',
          'onMouseDown',
          'onMouseEnter',
          'onMouseLeave',
          'onMouseMove',
          'onMouseOut',
          'onMouseOver',
          'onMouseUp',
        ],
      },
    ],
    'react/no-danger': 'error',
    'jsx-a11y/prefer-tag-over-role': 'off',
    'jsx-a11y/no-autofocus': 'off',
    'jsx-a11y/no-noninteractive-element-interactions': 'off',
    'jsx-a11y/interactive-supports-focus': 'off',
    'jsx-a11y/media-has-caption': 'off',
    'jsx-a11y/control-has-associated-label': 'off',
    'jsx-a11y/role-has-required-aria-props': 'off',
    'jsx-a11y/heading-has-content': 'off',
  },
  overrides: [
    {
      files: ['**/*.{ts,tsx}'],
      rules: {
        'typescript/no-deprecated': 'error',
      },
    },
    {
      files: ['**/*.test.{ts,tsx,cts,mts,mjs}'],
      rules: {
        'eslint-js/no-restricted-syntax': ['error', ...restrictedSyntax, noRequireInTests],
      },
    },
  ],
});
