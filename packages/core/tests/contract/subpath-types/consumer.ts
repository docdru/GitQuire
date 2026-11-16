export type {
  addsBlankLines,
  bindFrontmatterDoc,
  composeWithDerivedBody,
  FrontmatterBinding,
  FrontmatterSnapshot,
  fnv1aDigest,
  normalizeBridge,
  readFmKeys,
  readFmRegionWithError,
  SynthesisedConflictRegion,
  synthesiseConflictMarkersWithRegions,
} from '@gitquire/core/bridge';
export type { isSurfacedCheckpointKind } from '@gitquire/core/checkpoint-kinds';
export type {
  CLIENT_RUNTIME_VERSION_FALLBACK,
  CLIENT_SURFACE_ATTRIBUTE,
  ClientSurface,
  ClientSurfaceReading,
  ClientVersionTokenFields,
  clientVersionHeaders,
  clientVersionTokenFields,
  deriveClientSurface,
  readClientSurface,
} from '@gitquire/core/client-version';
export type {
  COMMAND_IDENTITIES,
  CommandContext,
  CommandIdentity,
  evaluateCommandAvailability,
} from '@gitquire/core/commands/command-identity';
export type {
  commentLeafText,
  commentQuoteText,
} from '@gitquire/core/comments/leaf-text';
export type {
  contextEvidenceFloor,
  contextMatchScore,
  findAllPassages,
  PassageMatch,
  rewriteCeiling,
} from '@gitquire/core/comments/passage-match';
export type {
  isSyncMode,
  modeFromCommittedDefault,
  resolveAutoSyncIntervals,
  resolveLocalAutoSyncMode,
  StoredSyncActiveMode,
  StoredSyncMode,
  SYNC_INTERVAL_PRESET_SECONDS,
  SyncActiveMode,
  SyncMode,
} from '@gitquire/core/config/auto-sync-mode';
export type {
  bindConfigDoc,
  ConfigBinding,
  ConfigBindingPatchResult,
} from '@gitquire/core/config/bind-config-doc';
export type {
  bindOkignoreDoc,
  OkignoreBinding,
} from '@gitquire/core/config/bind-okignore-doc';
export type {
  ConfigIssue,
  ConfigValidationError,
  humanFormat,
  isKnownConfigError,
  WriteScope,
} from '@gitquire/core/config/errors';
export type { getFieldMeta } from '@gitquire/core/config/field-registry';
export type { mergeLayered } from '@gitquire/core/config/merge-layered';
export type {
  Config,
  ConfigPatch,
  ConfigSchema,
  checkEmbeddingsBaseUrl,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
  DEFAULT_EMBEDDINGS_MODEL,
  DEFAULT_TUNNEL_PORT,
  MAX_EMBEDDINGS_DOC_TIMEOUT_MS,
  MAX_EMBEDDINGS_MAX_BATCH_CHARS,
  MAX_EMBEDDINGS_MAX_BATCH_SIZE,
  MIN_EMBEDDINGS_DOC_TIMEOUT_MS,
  MIN_EMBEDDINGS_MAX_BATCH_CHARS,
  MIN_EMBEDDINGS_MAX_BATCH_SIZE,
  normalizeAttachmentFolderPath,
} from '@gitquire/core/config/schema';
export type { resolveLeafSchema } from '@gitquire/core/config/schema-leaf';
export type {
  evictStaleEntries,
  FLASH_DEBOUNCE_MS,
  FLASH_DURATION_MS,
  hasNewEntries,
} from '@gitquire/core/constants/activity';
export type {
  CC1_CONTRACT_VERSION,
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAMES,
  isManagedArtifactDocName,
  parseLegacyTemplateDocName,
  parseTemplateContentDocName,
  SYSTEM_DOC_NAME,
  stripMdExt,
  templateContentDocName,
} from '@gitquire/core/constants/cc1';
export type { CHROME_BG_DARK, CHROME_BG_LIGHT } from '@gitquire/core/constants/chrome';
export type {
  codeLanguageForExtension,
  EDITABLE_TEXT_EXTRA_LANGUAGE,
  isEditableTextDocFile,
} from '@gitquire/core/constants/code-languages';
export type { LINEAGE_EPOCH_KEY } from '@gitquire/core/constants/doc-lifecycle';
export type {
  DOCUMENT_OPEN_BYTE_LIMIT,
  isDocumentOverOpenByteLimit,
  TEXT_DOC_OPEN_BYTE_LIMIT,
} from '@gitquire/core/constants/document-open';
export type {
  detectEmbeddedHostFromBrowser,
  EmbeddedHost,
} from '@gitquire/core/constants/embedded-host';
export type { normalizeGitHostname } from '@gitquire/core/constants/github';
export type {
  isOrphanMode,
  ORPHAN_MODES,
  OrphanMode,
} from '@gitquire/core/constants/graph';
export type {
  OPEN_KNOWLEDGE_DOCS_URL,
  OPEN_KNOWLEDGE_GITHUB_URL,
  OPEN_KNOWLEDGE_ISSUES_URL,
} from '@gitquire/core/constants/menu-labels';
export type {
  OK_USER_HOME_AUTH_FILE,
  okUserHomeDisplayPath,
} from '@gitquire/core/constants/ok-dir';
export type { okUserHomeDir } from '@gitquire/core/constants/ok-user-home';
export type {
  PREVIEW_EMBED_STARTERS,
  PreviewEmbedStarter,
} from '@gitquire/core/constants/preview-embed-starters';
export type { PREVIEW_THEME_TOKENS } from '@gitquire/core/constants/preview-theme-tokens';
export type {
  DESKTOP_PRODUCTS,
  desktopChannelLabel,
} from '@gitquire/core/constants/product';
export type {
  ALLOWED_IMAGE_MIME_TYPES,
  ASSET_EXTENSIONS,
  AUDIO_EXTENSIONS,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_DEDUP_UI,
  DEFAULT_EMIT_FORMAT,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  FILE_ATTACHMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  InlineAssetMediaKind,
  isExcalidrawDocFile,
  isMarkdownDocFile,
  isMermaidDocFile,
  mediaKindForSidebarAssetExtension,
  VIDEO_EXTENSIONS,
  WIKI_EMBED_EXTENSIONS,
} from '@gitquire/core/constants/upload';
export type { CodeBlockFidelity } from '@gitquire/core/extensions/code-block-fidelity';
export type {
  collectFootnoteIdentifiers,
  findFootnoteDefinitionInsertPos,
  nextFootnoteIdentifier,
} from '@gitquire/core/extensions/footnote-reference';
export type {
  FM_FENCE_LINE_RE,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@gitquire/core/extensions/frontmatter';
export type { ImageReferenceFidelity } from '@gitquire/core/extensions/image-reference-fidelity';
export type { ImageSrcFidelity } from '@gitquire/core/extensions/image-src-fidelity';
export type { JsxComponent } from '@gitquire/core/extensions/jsx-component';
export type { JsxInline } from '@gitquire/core/extensions/jsx-inline';
export type {
  isAllowedLinkUri,
  LinkFidelity,
  LinkStyle,
} from '@gitquire/core/extensions/link-fidelity';
export type { MathInline } from '@gitquire/core/extensions/math-inline';
export type { RawMdxFallback } from '@gitquire/core/extensions/raw-mdx-fallback';
export type { sharedExtensions } from '@gitquire/core/extensions/shared';
export type { Tag } from '@gitquire/core/extensions/tag';
export type {
  getWikiLinkText,
  normalizeNullableString,
  parseWikiLink,
  WikiLink,
} from '@gitquire/core/extensions/wiki-link';
export type { WikiLinkEmbed } from '@gitquire/core/extensions/wiki-link-embed';
export type {
  FrontmatterValidationError,
  fieldErrorsFromError,
} from '@gitquire/core/frontmatter/errors';
export type {
  FrontmatterMap,
  FrontmatterPatch,
  FrontmatterType,
  FrontmatterValue,
  frontmatterValuesEqual,
  inferType,
  isFrontmatterValueEmpty,
  RESERVED_FRONTMATTER_KEY,
} from '@gitquire/core/frontmatter/schema';
export type {
  extractFrontmatterTags,
  FRONTMATTER_TAG_GRAMMAR_HINT,
  FRONTMATTER_TAG_VALUE_RE,
  isValidFrontmatterTagValue,
} from '@gitquire/core/frontmatter/tags';
export type {
  diffFrontmatter,
  FrontmatterDelta,
  PropertyChange,
} from '@gitquire/core/frontmatter-diff';
export type {
  WorktreeInventoryEntry,
  WorktreeInventoryLocation,
  WorktreeInventoryModel,
  WorktreeInventoryOpenRequest,
} from '@gitquire/core/git/worktree-inventory-model';
export type {
  stripRemotePrefix,
  WorktreeCreateResult,
  WorktreeSelectorEntry,
  WorktreeSelectorModel,
} from '@gitquire/core/git/worktree-selector-model';
export type { readBrowserLanguages } from '@gitquire/core/i18n/browser-locale-provider';
export type { localeDirection } from '@gitquire/core/i18n/direction';
export type {
  AUTO_DETECTABLE_LOCALES,
  LanguagePreference,
  PICKER_LOCALES,
  SUPPORTED_LOCALES,
  SupportedLocale,
} from '@gitquire/core/i18n/locales';
export type {
  FALLBACK_LOCALE,
  resolveLocale,
} from '@gitquire/core/i18n/resolve-locale';
export type {
  BUG_REPORT_ATTACHMENT_CONTENT_TYPES,
  BUG_REPORT_ATTACHMENT_EXTENSIONS,
  BUG_REPORT_SCREENSHOT_ZIP_ENTRY,
  isBugReportAgentChatEntry,
  isBugReportAttachmentEntry,
  isBugReportCrashDumpEntry,
  MAX_BUG_REPORT_ATTACHMENTS,
  MAX_BUG_REPORT_ATTACHMENTS_TOTAL_BYTES,
  OkBugReportCrashDetectedEvent,
  OkBugReportListRow,
  OkBugReportScreenshot,
  OkBugReportSendMetadata,
  OkBugReportSendResult,
  OkImageAttachmentContentType,
  ReportBundleSummary,
} from '@gitquire/core/logger-types';
export type {
  LOGGER_OWNED_FIELDS,
  parseStructuredConsoleMessage,
  RENDERER_LOG_MAX_BATCH_BYTES,
  RENDERER_LOG_MAX_ENTRIES,
  RENDERER_LOG_MAX_MESSAGE_BYTES,
  truncateLogMessage,
} from '@gitquire/core/logging/renderer-log';
export type { scrubSecrets } from '@gitquire/core/logging/secret-scrub';
export type { MarkdownManager } from '@gitquire/core/markdown';
export type {
  selectFenceChar,
  widenFenceLength,
} from '@gitquire/core/markdown/code-fence';
export type {
  HtmlPayloadTooLargeError,
  htmlToMdast,
  mdastToMarkdown,
} from '@gitquire/core/markdown/html-to-mdast';
export type {
  AppliesToPatternSummary,
  assertNeverOkfRuleGroupId,
  assertNeverOkfRuleId,
  compileAppliesTo,
  countDiagnosticsBySource,
  DEFAULT_LINKS_VALIDATION,
  DEFAULT_LINTER_CONFIG,
  DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES,
  displayCategoryForRule,
  FrontmatterFieldConstraint,
  FrontmatterSchemaMapping,
  FrontmatterSchemasListSuccessSchema,
  FrontmatterScope,
  findRuleConfigEntry,
  findZeroMatchAppliesToPatterns,
  isAuditEmptyScopeWarning,
  isFrontmatterSchemaAsset,
  isFrontmatterScoped,
  isMarkdownlintJsonConfig,
  isOkfRuleEnabled,
  LINT_PLUGINS,
  LinksValidationSetting,
  LintConfigResponse,
  LintConfigResponseSchema,
  LintDiagnostic,
  LinterConfig,
  LintFixResult,
  LintFixResultSchema,
  LintPluginId,
  LintPosition,
  LintTextEdit,
  lintDocument,
  MARKDOWNLINT_RULE_CATALOG,
  MarkdownlintRuleSetting,
  MarkdownlintRuleSeverity,
  MarkdownlintRuleWriteValue,
  OKF_RULE_GROUPS,
  OKF_RULE_IDS,
  OkfRuleGroupId,
  OkfRuleId,
  PersistedLinterConfig,
  RULE_DISPLAY_CATEGORIES,
  RuleCatalogEntry,
  RuleDisplayCategory,
  RuleOptionSpec,
  SchemaParentPathSegment,
  selectFrontmatterOnlyConfig,
  selectGoverningFrontmatterSchemas,
  summarizeAppliesTo,
  toEffectiveBase,
  ValidationAuditCountsResponse,
  ValidationAuditCountsResponseSchema,
  ValidationAuditResponse,
  ValidationAuditResponseSchema,
  ValidationDocCounts,
  ValidationDocResult,
  ValidationSourceCounts,
  ValidationSourceKey,
} from '@gitquire/core/markdown/lint';
export type {
  markdownToHtml,
  mdastToHtml,
} from '@gitquire/core/markdown/mdast-to-html';
export type { normalizeReferenceLabel } from '@gitquire/core/markdown/reference-label';
export type { normalizeDocRelativeAssetUrl } from '@gitquire/core/markdown/resolve-image-url';
export type {
  isRelativeUrl,
  isSafeUrl,
  SAFE_URL_SCHEME_RE,
  SAFE_URL_SCHEMES,
} from '@gitquire/core/markdown/safe-url';
export type { INLINE_TAG_VALUE_RE } from '@gitquire/core/markdown/tag-promotion';
export type {
  incrementBlockGripClickSelectFailed,
  incrementJsxActionAborted,
  incrementJsxArrowNodeSelectFailed,
  incrementJsxAutoConvertFailed,
  incrementJsxAutoConvertSucceeded,
  incrementJsxChromeDeleteFailed,
  incrementJsxKeyboardDeleteFailed,
  incrementJsxMoveFailed,
  incrementJsxPopoverCloseRestoreFailed,
  incrementJsxPropDropped,
  incrementJsxRenderFailure,
  incrementJsxStuckCopyFailed,
  incrementJsxStuckDeleteFailed,
  JsxNodeAction,
} from '@gitquire/core/metrics/parse-health';
export type { createRegistry } from '@gitquire/core/registry';
export type {
  JsxComponentMeta,
  PropDef,
  PropDefString,
} from '@gitquire/core/registry/types';
export type {
  ActivityAgentHeader,
  ActivityBurst,
  ActivityFile,
  AgentActivitySuccessSchema,
  AgentBurstDiffSuccessSchema,
  assertNeverSemanticQueryOutcome,
  BacklinkCountsSuccessSchema,
  BacklinkEntry,
  BacklinksSuccessSchema,
  BranchInfoResponse,
  BrokenLinkSuppression,
  CheckoutResponse,
  ClientLogEntry,
  ConflictEntryWire,
  CreateFolderSuccessSchema,
  CreatePageSuccessSchema,
  classifySemanticProviderError,
  DeletePathSuccessSchema,
  DocumentListEntry,
  DocumentListEntrySchema,
  DocumentListSuccess,
  DocumentListSuccessSchema,
  DocumentReadSuccessSchema,
  DuplicatePathSuccess,
  DuplicatePathSuccessSchema,
  FolderConfigWarningCode,
  ForwardLinkEntry,
  ForwardLinkLocalTarget,
  ForwardLinksSuccess,
  ForwardLinksSuccessSchema,
  GitHubReferencePreview,
  GitHubReferenceResponseSchema,
  GitStatusCode,
  GitWorktreeEntry,
  GitWorktreeOpenTarget,
  GitWorktreeStatusSuccess,
  HubEntry,
  HubsSuccessSchema,
  isSemanticSearchOffered,
  LinkGraphSuccessSchema,
  LinkPreviewMetadata,
  LinkPreviewResponseSchema,
  LocalOpEmbeddingsTestResponse,
  LocalOpEmbeddingsTestResponseSchema,
  normalizeApiWarnings,
  OrphanEntry,
  OrphansSuccessSchema,
  PageHeadingsSuccessSchema,
  PagesSuccessSchema,
  PrincipalSuccessSchema,
  ProblemDetails,
  ProblemDetailsSchema,
  ProblemType,
  PullOutcome,
  PushPermissionWire,
  RenamedAssetMapping,
  RenamedDocMapping,
  RenamePathSuccessSchema,
  ResolveStrategyWire,
  SavedThemeDeleteSuccessSchema,
  SavedThemeListEntry,
  SavedThemeSaveRequest,
  SavedThemeSaveRequestSchema,
  SavedThemeSaveSuccessSchema,
  SavedThemeScheme,
  SavedThemeSchemeSchema,
  SavedThemesListSuccessSchema,
  SavedThemeUpdateRequestSchema,
  SavedThemeUpdateSuccessSchema,
  SearchSemanticStatus,
  SearchSemanticStatusSchema,
  SemanticIndexStatus,
  SemanticIndexStatusSchema,
  ServerInfoSuccessSchema,
  ShareConstructUrlErrorCode,
  ShareConstructUrlRequest,
  ShareConstructUrlResponse,
  ShareConstructUrlResponseSchema,
  ShareFreshness,
  SharePublishErrorCode,
  SharePublishNameCheckResponse,
  SharePublishNameCheckResponseSchema,
  SharePublishOwner,
  SharePublishOwnersResponse,
  SharePublishOwnersResponseSchema,
  SharePublishRequest,
  SharePublishResponse,
  SharePublishResponseSchema,
  SharePublishVisibility,
  ShareTargetStatusResponse,
  SyncConflictContentSuccess,
  SyncConflictContentSuccessSchema,
  SyncConflictsSuccessSchema,
  SyncErrorCode,
  SyncStatusSchema,
  semanticProviderErrorBlocks,
  TEMPLATE_NAME_REGEX,
  TemplatesListEntry,
  TemplatesListSuccessSchema,
  TrashCleanupSuccessSchema,
  UploadAssetSuccess,
  UploadAssetSuccessSchema,
  WorkspaceSuccessSchema,
} from '@gitquire/core/schemas/api';
export type {
  CC1_CHANNEL_BRANCH_SWITCHED,
  CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
  CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
  CC1_CHANNEL_DISK_ACK,
  CC1BranchSwitchedPayload,
  CC1BranchSwitchedPayloadSchema,
  CC1ConfigIgnoreNestedErrorPayload,
  CC1ConfigIgnoreNestedErrorPayloadSchema,
  CC1ConfigValidationRejectedPayload,
  CC1ConfigValidationRejectedPayloadSchema,
  CC1DerivedViewPayload,
  CC1DerivedViewPayloadSchema,
  CC1DiskAckPayloadSchema,
  CC1ServerInfoPayload,
  CC1ServerInfoPayloadSchema,
  DerivedViewChannel,
  DerivedViewChannelSchema,
} from '@gitquire/core/schemas/cc1';
export type {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  MAX_WORKSPACE_SEARCH_LIMIT,
  searchWorkspaceCorpus,
  WorkspaceSearchCorpus,
  WorkspaceSearchDocument,
  WorkspaceSearchKind,
  workspaceSearchBasename,
} from '@gitquire/core/search/workspace-search';
export type { planHasOutstandingWork } from '@gitquire/core/seed-plan-work';
export type { SyncPausedReason } from '@gitquire/core/sync-paused-reason';
export type {
  AnsiSlotName,
  BASE16_SLOT_ROLES,
  BASE16_SLOTS,
  Base16Palette,
  Base16ParseError,
  Base16Scheme,
  Base16Slot,
  base16ToTokens,
  base16ToYaml,
  contrastRatio,
  isBase16Hex,
  MINIMUM_CONTRAST_RATIO,
  mixHex,
  nearestReading,
  parseBase16Scheme,
  relativeLuminance,
} from '@gitquire/core/theme/base16';
export type {
  ColorThemeSelection,
  ColorThemeSelectionInput,
  deriveSavedThemeName,
  generateColorThemesCss,
  isDarkTheme,
  parseSavedThemeId,
  renderThemeBlock,
  resolveColorThemeSelection,
  resolveModePreference,
  resolveThemePlugin,
  THEME_PLUGINS,
  ThemePlugin,
} from '@gitquire/core/theme/theme-plugins';
export type {
  AgentFlashEntry,
  AgentPresenceEntry,
  AwarenessState,
  AwarenessUser,
  isPresenceSentinelDocName,
} from '@gitquire/core/types/awareness';
export type { Identity } from '@gitquire/core/types/identity';
export type { Principal } from '@gitquire/core/types/principal';
export type { TimelineEntry } from '@gitquire/core/types/timeline';
export type {
  atomicWriteFile,
  atomicWriteFileSync,
} from '@gitquire/core/util/atomic-yaml-write';
export type {
  isHiddenDocName,
  isProjectSkillBundlePath,
} from '@gitquire/core/util/doc-name';
export type { toDesktopAssetHref } from '@gitquire/core/utils/asset-href';
export type {
  ChunkedInsertError,
  chunkedYTextInsert,
} from '@gitquire/core/utils/chunked-insert';
export type { createCodeFenceTracker } from '@gitquire/core/utils/code-fence-tracker';
export type { rewriteEmbedUrl } from '@gitquire/core/utils/embed-url-rewrite';
export type { extensionOf } from '@gitquire/core/utils/extension';
export type { formatFileSize } from '@gitquire/core/utils/file-size';
export type { getGitHubStars } from '@gitquire/core/utils/github-stars';
export type {
  graphemePrefix,
  graphemeSuffix,
} from '@gitquire/core/utils/grapheme-clip';
export type { scanHeadingLine } from '@gitquire/core/utils/heading-scan';
export type {
  AGENT_ICON_COLORS,
  AGENT_ICON_COLORS_DARK,
  colorFromSeed,
  computeInitials,
  deriveIconColor,
  formatPresenceLabel,
  getIdentity,
  HUMAN_COLORS,
  iconFromClientName,
  SYSTEM_WRITER_DISPLAY_NAMES,
} from '@gitquire/core/utils/identity';
export type {
  assertNeverLinkTarget,
  buildRelativeMarkdownHref,
  ClassifiedLinkTarget,
  classifyMarkdownHref,
  DocLinkTarget,
  extractAssetExtension,
  isExternalHref,
  resolveAssetProjectPath,
} from '@gitquire/core/utils/link-targets';
export type { localIsoDate } from '@gitquire/core/utils/local-iso-date';
export type { isLoomUrl, parseLoomUrl } from '@gitquire/core/utils/loom-embed';
export type { parsePdfAnchor } from '@gitquire/core/utils/pdf-anchor';
export type { randomUUID } from '@gitquire/core/utils/random-uuid';
export type { formatRelativeAge } from '@gitquire/core/utils/relative-time';
export type {
  getHeadingSlug,
  HeadingEntry,
  toWikiLinkSlug,
  wikiLinkHref,
} from '@gitquire/core/utils/slug';
export type {
  asTargetNamespace,
  createTargetNamespace,
  isTargetNamespace,
  MutableTargetNamespace,
  resolveName,
  TargetMatch,
  TargetNamespace,
} from '@gitquire/core/utils/target-namespace';
export type { isVimeoUrl } from '@gitquire/core/utils/vimeo-embed';
export type {
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  buildWikiLinkAssetTargetKeys,
  getWikiLinkResolutionCandidates,
  isResolvedWikiLinkTarget,
  resolveWikiLinkAssetTarget,
  resolveWikiLinkTarget,
  resolveWikiLinkTargetDocName,
  WikiLinkLookupIndex,
} from '@gitquire/core/utils/wiki-link-resolve';
export type {
  ParsedYouTubeUrl,
  parseYouTubeUrl,
} from '@gitquire/core/utils/youtube-embed';
