import { readFileSync } from 'node:fs';
import * as root from '@gitquire/core';
import * as bridgeSubpath from '@gitquire/core/bridge';
import * as checkpointKindsSubpath from '@gitquire/core/checkpoint-kinds';
import * as clientVersionSubpath from '@gitquire/core/client-version';
import * as commandsCommandIdentitySubpath from '@gitquire/core/commands/command-identity';
import * as commentsLeafTextSubpath from '@gitquire/core/comments/leaf-text';
import * as commentsPassageMatchSubpath from '@gitquire/core/comments/passage-match';
import * as configAutoSyncModeSubpath from '@gitquire/core/config/auto-sync-mode';
import * as configBindConfigDocSubpath from '@gitquire/core/config/bind-config-doc';
import * as configBindOkignoreDocSubpath from '@gitquire/core/config/bind-okignore-doc';
import * as configErrorsSubpath from '@gitquire/core/config/errors';
import * as configFieldRegistrySubpath from '@gitquire/core/config/field-registry';
import * as configMergeLayeredSubpath from '@gitquire/core/config/merge-layered';
import * as configSchemaSubpath from '@gitquire/core/config/schema';
import * as configSchemaLeafSubpath from '@gitquire/core/config/schema-leaf';
import * as constantsActivitySubpath from '@gitquire/core/constants/activity';
import * as constantsCc1Subpath from '@gitquire/core/constants/cc1';
import * as constantsChromeSubpath from '@gitquire/core/constants/chrome';
import * as constantsCodeLanguagesSubpath from '@gitquire/core/constants/code-languages';
import * as constantsDocLifecycleSubpath from '@gitquire/core/constants/doc-lifecycle';
import * as constantsDocumentOpenSubpath from '@gitquire/core/constants/document-open';
import * as constantsEmbeddedHostSubpath from '@gitquire/core/constants/embedded-host';
import * as constantsGithubSubpath from '@gitquire/core/constants/github';
import * as constantsGraphSubpath from '@gitquire/core/constants/graph';
import * as constantsMenuLabelsSubpath from '@gitquire/core/constants/menu-labels';
import * as constantsOkDirSubpath from '@gitquire/core/constants/ok-dir';
import * as constantsOkUserHomeSubpath from '@gitquire/core/constants/ok-user-home';
import * as constantsPreviewEmbedStartersSubpath from '@gitquire/core/constants/preview-embed-starters';
import * as constantsPreviewThemeTokensSubpath from '@gitquire/core/constants/preview-theme-tokens';
import * as constantsProductSubpath from '@gitquire/core/constants/product';
import * as constantsUploadSubpath from '@gitquire/core/constants/upload';
import * as extensionsCodeBlockFidelitySubpath from '@gitquire/core/extensions/code-block-fidelity';
import * as extensionsFootnoteReferenceSubpath from '@gitquire/core/extensions/footnote-reference';
import * as extensionsFrontmatterSubpath from '@gitquire/core/extensions/frontmatter';
import * as extensionsGitquireCommentsSubpath from '@gitquire/core/extensions/gitquire-comments';
import * as extensionsImageReferenceFidelitySubpath from '@gitquire/core/extensions/image-reference-fidelity';
import * as extensionsImageSrcFidelitySubpath from '@gitquire/core/extensions/image-src-fidelity';
import * as extensionsJsxComponentSubpath from '@gitquire/core/extensions/jsx-component';
import * as extensionsJsxInlineSubpath from '@gitquire/core/extensions/jsx-inline';
import * as extensionsLinkFidelitySubpath from '@gitquire/core/extensions/link-fidelity';
import * as extensionsMathInlineSubpath from '@gitquire/core/extensions/math-inline';
import * as extensionsRawMdxFallbackSubpath from '@gitquire/core/extensions/raw-mdx-fallback';
import * as extensionsSharedSubpath from '@gitquire/core/extensions/shared';
import * as extensionsTagSubpath from '@gitquire/core/extensions/tag';
import * as extensionsWikiLinkSubpath from '@gitquire/core/extensions/wiki-link';
import * as extensionsWikiLinkEmbedSubpath from '@gitquire/core/extensions/wiki-link-embed';
import * as frontmatterErrorsSubpath from '@gitquire/core/frontmatter/errors';
import * as frontmatterSchemaSubpath from '@gitquire/core/frontmatter/schema';
import * as frontmatterTagsSubpath from '@gitquire/core/frontmatter/tags';
import * as frontmatterDiffSubpath from '@gitquire/core/frontmatter-diff';
import * as gitWorktreeInventoryModelSubpath from '@gitquire/core/git/worktree-inventory-model';
import * as gitWorktreeSelectorModelSubpath from '@gitquire/core/git/worktree-selector-model';
import * as gitquireCommentThreadsSubpath from '@gitquire/core/gitquire/comment-threads';
import * as gitquireNamingSubpath from '@gitquire/core/gitquire/naming';
import * as gitquireTypedLinksSubpath from '@gitquire/core/gitquire/typed-links';
import * as i18nBrowserLocaleProviderSubpath from '@gitquire/core/i18n/browser-locale-provider';
import * as i18nDirectionSubpath from '@gitquire/core/i18n/direction';
import * as i18nLocalesSubpath from '@gitquire/core/i18n/locales';
import * as i18nResolveLocaleSubpath from '@gitquire/core/i18n/resolve-locale';
import * as loggerTypesSubpath from '@gitquire/core/logger-types';
import * as loggingRendererLogSubpath from '@gitquire/core/logging/renderer-log';
import * as loggingSecretScrubSubpath from '@gitquire/core/logging/secret-scrub';
import * as markdownSubpath from '@gitquire/core/markdown';
import * as markdownCodeFenceSubpath from '@gitquire/core/markdown/code-fence';
import * as markdownHtmlToMdastSubpath from '@gitquire/core/markdown/html-to-mdast';
import * as markdownLintSubpath from '@gitquire/core/markdown/lint';
import * as markdownMdastToHtmlSubpath from '@gitquire/core/markdown/mdast-to-html';
import * as markdownReferenceLabelSubpath from '@gitquire/core/markdown/reference-label';
import * as markdownResolveImageUrlSubpath from '@gitquire/core/markdown/resolve-image-url';
import * as markdownSafeUrlSubpath from '@gitquire/core/markdown/safe-url';
import * as markdownTagPromotionSubpath from '@gitquire/core/markdown/tag-promotion';
import * as metricsParseHealthSubpath from '@gitquire/core/metrics/parse-health';
import * as registrySubpath from '@gitquire/core/registry';
import * as registryTypesSubpath from '@gitquire/core/registry/types';
import * as schemasApiSubpath from '@gitquire/core/schemas/api';
import * as schemasCc1Subpath from '@gitquire/core/schemas/cc1';
import * as searchWorkspaceSearchSubpath from '@gitquire/core/search/workspace-search';
import * as seedPlanWorkSubpath from '@gitquire/core/seed-plan-work';
import * as serverBarrel from '@gitquire/core/server';
import * as syncPausedReasonSubpath from '@gitquire/core/sync-paused-reason';
import * as themeBase16Subpath from '@gitquire/core/theme/base16';
import * as themeThemePluginsSubpath from '@gitquire/core/theme/theme-plugins';
import * as typesAwarenessSubpath from '@gitquire/core/types/awareness';
import * as typesIdentitySubpath from '@gitquire/core/types/identity';
import * as typesPrincipalSubpath from '@gitquire/core/types/principal';
import * as typesTimelineSubpath from '@gitquire/core/types/timeline';
import * as utilAtomicYamlWriteSubpath from '@gitquire/core/util/atomic-yaml-write';
import * as utilDocNameSubpath from '@gitquire/core/util/doc-name';
import * as utilsAssetHrefSubpath from '@gitquire/core/utils/asset-href';
import * as utilsChunkedInsertSubpath from '@gitquire/core/utils/chunked-insert';
import * as utilsCodeFenceTrackerSubpath from '@gitquire/core/utils/code-fence-tracker';
import * as utilsEmbedUrlRewriteSubpath from '@gitquire/core/utils/embed-url-rewrite';
import * as utilsExtensionSubpath from '@gitquire/core/utils/extension';
import * as utilsFileSizeSubpath from '@gitquire/core/utils/file-size';
import * as utilsGithubStarsSubpath from '@gitquire/core/utils/github-stars';
import * as utilsGraphemeClipSubpath from '@gitquire/core/utils/grapheme-clip';
import * as utilsHeadingScanSubpath from '@gitquire/core/utils/heading-scan';
import * as utilsIdentitySubpath from '@gitquire/core/utils/identity';
import * as utilsLinkTargetsSubpath from '@gitquire/core/utils/link-targets';
import * as utilsLocalIsoDateSubpath from '@gitquire/core/utils/local-iso-date';
import * as utilsLoomEmbedSubpath from '@gitquire/core/utils/loom-embed';
import * as utilsPdfAnchorSubpath from '@gitquire/core/utils/pdf-anchor';
import * as utilsRandomUuidSubpath from '@gitquire/core/utils/random-uuid';
import * as utilsRelativeTimeSubpath from '@gitquire/core/utils/relative-time';
import * as utilsSlugSubpath from '@gitquire/core/utils/slug';
import * as utilsTargetNamespaceSubpath from '@gitquire/core/utils/target-namespace';
import * as utilsVimeoEmbedSubpath from '@gitquire/core/utils/vimeo-embed';
import * as utilsWikiLinkResolveSubpath from '@gitquire/core/utils/wiki-link-resolve';
import * as utilsYoutubeEmbedSubpath from '@gitquire/core/utils/youtube-embed';
import { describe, expect, test } from 'vitest';

const PRE_EXISTING_KEYS = [
  '.',
  './shadow-repo-layout',
  './git-repository',
  './server',
  './keepalive',
  './helper-bundle',
  './acp/thread-protocol',
  './desktop-bridge',
];

const MODULE_SUBPATHS: Record<string, object> = {
  './bridge': bridgeSubpath,
  './checkpoint-kinds': checkpointKindsSubpath,
  './client-version': clientVersionSubpath,
  './commands/command-identity': commandsCommandIdentitySubpath,
  './comments/leaf-text': commentsLeafTextSubpath,
  './comments/passage-match': commentsPassageMatchSubpath,
  './config/auto-sync-mode': configAutoSyncModeSubpath,
  './config/bind-config-doc': configBindConfigDocSubpath,
  './config/bind-okignore-doc': configBindOkignoreDocSubpath,
  './config/errors': configErrorsSubpath,
  './config/field-registry': configFieldRegistrySubpath,
  './config/merge-layered': configMergeLayeredSubpath,
  './config/schema': configSchemaSubpath,
  './config/schema-leaf': configSchemaLeafSubpath,
  './constants/activity': constantsActivitySubpath,
  './constants/cc1': constantsCc1Subpath,
  './constants/chrome': constantsChromeSubpath,
  './constants/code-languages': constantsCodeLanguagesSubpath,
  './constants/doc-lifecycle': constantsDocLifecycleSubpath,
  './constants/document-open': constantsDocumentOpenSubpath,
  './constants/embedded-host': constantsEmbeddedHostSubpath,
  './constants/github': constantsGithubSubpath,
  './constants/graph': constantsGraphSubpath,
  './constants/menu-labels': constantsMenuLabelsSubpath,
  './constants/ok-dir': constantsOkDirSubpath,
  './constants/preview-embed-starters': constantsPreviewEmbedStartersSubpath,
  './constants/preview-theme-tokens': constantsPreviewThemeTokensSubpath,
  './constants/product': constantsProductSubpath,
  './constants/upload': constantsUploadSubpath,
  './extensions/code-block-fidelity': extensionsCodeBlockFidelitySubpath,
  './extensions/footnote-reference': extensionsFootnoteReferenceSubpath,
  './extensions/frontmatter': extensionsFrontmatterSubpath,
  './extensions/gitquire-comments': extensionsGitquireCommentsSubpath,
  './extensions/image-reference-fidelity': extensionsImageReferenceFidelitySubpath,
  './extensions/image-src-fidelity': extensionsImageSrcFidelitySubpath,
  './extensions/jsx-component': extensionsJsxComponentSubpath,
  './extensions/jsx-inline': extensionsJsxInlineSubpath,
  './extensions/link-fidelity': extensionsLinkFidelitySubpath,
  './extensions/math-inline': extensionsMathInlineSubpath,
  './extensions/raw-mdx-fallback': extensionsRawMdxFallbackSubpath,
  './extensions/shared': extensionsSharedSubpath,
  './extensions/tag': extensionsTagSubpath,
  './extensions/wiki-link': extensionsWikiLinkSubpath,
  './extensions/wiki-link-embed': extensionsWikiLinkEmbedSubpath,
  './frontmatter-diff': frontmatterDiffSubpath,
  './frontmatter/errors': frontmatterErrorsSubpath,
  './frontmatter/schema': frontmatterSchemaSubpath,
  './frontmatter/tags': frontmatterTagsSubpath,
  './git/worktree-inventory-model': gitWorktreeInventoryModelSubpath,
  './git/worktree-selector-model': gitWorktreeSelectorModelSubpath,
  './gitquire/comment-threads': gitquireCommentThreadsSubpath,
  './gitquire/naming': gitquireNamingSubpath,
  './gitquire/typed-links': gitquireTypedLinksSubpath,
  './i18n/browser-locale-provider': i18nBrowserLocaleProviderSubpath,
  './i18n/direction': i18nDirectionSubpath,
  './i18n/locales': i18nLocalesSubpath,
  './i18n/resolve-locale': i18nResolveLocaleSubpath,
  './logger-types': loggerTypesSubpath,
  './logging/renderer-log': loggingRendererLogSubpath,
  './logging/secret-scrub': loggingSecretScrubSubpath,
  './markdown': markdownSubpath,
  './markdown/code-fence': markdownCodeFenceSubpath,
  './markdown/html-to-mdast': markdownHtmlToMdastSubpath,
  './markdown/lint': markdownLintSubpath,
  './markdown/mdast-to-html': markdownMdastToHtmlSubpath,
  './markdown/reference-label': markdownReferenceLabelSubpath,
  './markdown/resolve-image-url': markdownResolveImageUrlSubpath,
  './markdown/safe-url': markdownSafeUrlSubpath,
  './markdown/tag-promotion': markdownTagPromotionSubpath,
  './metrics/parse-health': metricsParseHealthSubpath,
  './registry': registrySubpath,
  './registry/types': registryTypesSubpath,
  './schemas/api': schemasApiSubpath,
  './schemas/cc1': schemasCc1Subpath,
  './search/workspace-search': searchWorkspaceSearchSubpath,
  './seed-plan-work': seedPlanWorkSubpath,
  './sync-paused-reason': syncPausedReasonSubpath,
  './theme/base16': themeBase16Subpath,
  './theme/theme-plugins': themeThemePluginsSubpath,
  './types/awareness': typesAwarenessSubpath,
  './types/identity': typesIdentitySubpath,
  './types/principal': typesPrincipalSubpath,
  './types/timeline': typesTimelineSubpath,
  './util/doc-name': utilDocNameSubpath,
  './utils/asset-href': utilsAssetHrefSubpath,
  './utils/chunked-insert': utilsChunkedInsertSubpath,
  './utils/code-fence-tracker': utilsCodeFenceTrackerSubpath,
  './utils/embed-url-rewrite': utilsEmbedUrlRewriteSubpath,
  './utils/extension': utilsExtensionSubpath,
  './utils/file-size': utilsFileSizeSubpath,
  './utils/github-stars': utilsGithubStarsSubpath,
  './utils/grapheme-clip': utilsGraphemeClipSubpath,
  './utils/heading-scan': utilsHeadingScanSubpath,
  './utils/identity': utilsIdentitySubpath,
  './utils/link-targets': utilsLinkTargetsSubpath,
  './utils/local-iso-date': utilsLocalIsoDateSubpath,
  './utils/loom-embed': utilsLoomEmbedSubpath,
  './utils/pdf-anchor': utilsPdfAnchorSubpath,
  './utils/random-uuid': utilsRandomUuidSubpath,
  './utils/relative-time': utilsRelativeTimeSubpath,
  './utils/slug': utilsSlugSubpath,
  './utils/target-namespace': utilsTargetNamespaceSubpath,
  './utils/vimeo-embed': utilsVimeoEmbedSubpath,
  './utils/wiki-link-resolve': utilsWikiLinkResolveSubpath,
  './utils/youtube-embed': utilsYoutubeEmbedSubpath,
};

const SERVER_MODULE_SUBPATHS: Record<string, object> = {
  './constants/ok-user-home': constantsOkUserHomeSubpath,
  './util/atomic-yaml-write': utilAtomicYamlWriteSubpath,
};

const CONDITION_ORDER = ['@gitquire/source', 'development', 'types', 'default'];

const packageJson: { exports: Record<string, Record<string, string>> } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

const MODULE_SUBPATH_KEYS = Object.keys({ ...MODULE_SUBPATHS, ...SERVER_MODULE_SUBPATHS });

const rootBindings = new Map(Object.entries(root));
const serverBindings = new Map(Object.entries(serverBarrel));

describe('per-module core subpaths', () => {
  test('every export key beside the pre-existing entries is imported by this contract', () => {
    const declared = Object.keys(packageJson.exports).filter(
      (key) => !PRE_EXISTING_KEYS.includes(key),
    );
    expect(MODULE_SUBPATH_KEYS.toSorted()).toEqual(declared.toSorted());
  });

  test.each(MODULE_SUBPATH_KEYS)(
    '%s points its conditions at the module its name implies',
    (key) => {
      const conditions = packageJson.exports[key];
      const modulePath = key.slice(2);
      const flatName = modulePath.replaceAll('/', '-');
      expect(Object.keys(conditions ?? {})).toEqual(CONDITION_ORDER);
      expect([`./src/${modulePath}.ts`, `./src/${modulePath}/index.ts`]).toContain(
        conditions?.['@gitquire/source'],
      );
      expect(conditions?.development).toBe(conditions?.['@gitquire/source']);
      expect(conditions?.types).toBe(`./dist/${flatName}.d.mts`);
      expect(conditions?.default).toBe(`./dist/${flatName}.mjs`);
    },
  );

  test.each(Object.entries(MODULE_SUBPATHS))(
    '%s serves the same runtime bindings as the root barrel',
    (_key, namespace) => {
      const shared = Object.entries(namespace).filter(([name]) => rootBindings.has(name));
      const divergent = shared
        .filter(([name, value]) => value !== rootBindings.get(name))
        .map(([name]) => name);
      expect(divergent).toEqual([]);
    },
  );

  test.each(Object.entries(SERVER_MODULE_SUBPATHS))(
    '%s serves the same runtime bindings as the ./server barrel',
    (_key, namespace) => {
      const shared = Object.entries(namespace).filter(([name]) => serverBindings.has(name));
      const divergent = shared
        .filter(([name, value]) => value !== serverBindings.get(name))
        .map(([name]) => name);
      expect(divergent).toEqual([]);
      expect(shared.length).toBeGreaterThan(0);
    },
  );
});
