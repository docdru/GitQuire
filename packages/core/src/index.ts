// Bridge — observer/CRDT-bridge shared utilities (precedent #14)
export {
  addsBlankLines,
  applyFastDiff,
  applyIncrementalDiff,
  applyPatchToFm,
  type BridgeComposition,
  type BridgeInvariantSite,
  type BridgeInvariantViolation,
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  type BridgeMergeContentLossWhich,
  type BridgeToleranceSignal,
  bindFrontmatterDoc,
  comparePmStructural,
  composeWithDerivedBody,
  composeWithDerivedFrontmatter,
  createMergeBoundarySpace,
  createStructuralFreshnessChecker,
  DUPLICATION_GATE_MIN_LINE_LENGTH,
  defaultScheduler,
  detectAppliedToleranceClasses,
  detectFmRegion,
  diffLinesFast,
  docEdgeRunsDiffer,
  documentBodyLineEnding,
  emitToleranceFire,
  type FmEditError,
  FORM_WRITE_ORIGIN,
  type FrontmatterBinding,
  type FrontmatterDocProvider,
  findDroppedContent,
  findDroppedSourceContentInRange,
  fnv1aDigest,
  fragmentHoldsPendingContent,
  type InvariantViolation,
  isParseEquivalentBridge,
  type LfProjection,
  type LineEnding,
  locateBridgeDivergence,
  mergeThreeWay,
  normalizeBridge,
  overMultipliedBodyLines,
  PARSE_EQUIVALENCE_TOLERANCE,
  type PmStructuralNode,
  pendingContentLines,
  projectToLf,
  readFmMap,
  type Scheduler,
  type StructuralDivergenceReason,
  setToleranceTelemetryHook,
  spellLineEndings,
  splitFmBoundarySlot,
  type ToleranceFireRecord,
  toBridgeInvariantLog,
  tryLineLevelCombine,
} from './bridge/index.ts';
export {
  REPORT_SENT_MARKER_SUFFIX,
  REPORT_SIDECAR_BUNDLE_DIR,
} from './bug-report-sidecar/schema.ts';
export type { ParsedCheckpoint } from './checkpoint-kinds.ts';
export {
  CHECKPOINT_KINDS,
  isSurfacedCheckpointKind,
  parseCheckpoint,
} from './checkpoint-kinds.ts';
export {
  CLIENT_RUNTIME_VERSION_FALLBACK,
  CLIENT_SURFACE_ATTRIBUTE,
  CLIENT_VERSION_HEADER,
  type ClientSurfaceReading,
  clientVersionHeaders,
  readClientSurface,
} from './client-version.ts';
export { COMMAND_IDENTITIES } from './commands/command-identity.ts';
export {
  modeFromCommittedDefault,
  resolveAutoSyncIntervals,
  resolveLocalAutoSyncMode,
  type SyncMode,
  type SyncModeChangeSource,
} from './config/auto-sync-mode.ts';
export {
  bindConfigDoc,
  type ConfigBinding,
  type ConfigBindingPatchResult,
  type ConfigDocProvider,
} from './config/bind-config-doc.ts';
export type { OkignoreBinding } from './config/bind-okignore-doc.ts';
export {
  detectCommittedProjectLocalKeys,
  formatIgnoredCommittedKey,
  type IgnoredCommittedKey,
} from './config/committed-scope-diagnostics.ts';
export {
  applyConfigOverlay,
  type EnvConfigLayer,
  EnvVarError,
  resolveEnvConfigLayer,
} from './config/env-layer.ts';
export {
  type ConfigDiagnostic,
  type ConfigDiagnosticsReport,
  ConfigDiagnosticsReportSchema,
  type ConfigIssue,
  type ConfigValidationError,
  humanFormat,
  isKnownConfigError,
  type WriteScope,
} from './config/errors.ts';
export { fieldRegistry } from './config/field-registry.ts';
export { mergeLayered } from './config/merge-layered.ts';
export {
  detectRemovedKeys,
  REMOVED_KEYS,
  stripRemovedKeys,
} from './config/removed-keys.ts';
export {
  idleShutdownToMs,
  isLoopbackOnlyBind,
  requiresExternalConsent,
  resolveServerRuntimeConfig,
  type ServerRuntimeConfig,
} from './config/resolve-server-config.ts';
export {
  type AttachmentFolderPathVariableIssue,
  attachmentFolderForDocument,
  attachmentFolderPathVariableIssue,
  attachmentFolderSegmentMatcher,
  type Config,
  type ConfigPatch,
  ConfigSchema,
  checkEmbeddingsBaseUrl,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
  DEFAULT_EMBEDDINGS_MODEL,
  describeAttachmentFolderPathVariableIssue,
  IDLE_SHUTDOWN_DURATION_RE,
  isLoopbackEmbeddingsUrl,
  isValidAttachmentFolderPath,
  normalizeAttachmentFolderPath,
} from './config/schema.ts';
export {
  getLeafFieldMeta,
  resolveLeafSchema,
} from './config/schema-leaf.ts';
export { CONFIG_SCHEMA_MAJOR_PATH } from './config/schema-version.ts';
export { locateIssue } from './config/source-locator.ts';
export {
  addConfigSpanEvent,
  withConfigSpan,
  withConfigSpanSync,
} from './config/telemetry.ts';
export { changedBlockRange } from './constants/activity.ts';
export {
  CC1_CONTRACT_VERSION,
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAMES,
  type ConfigDocName,
  isManagedArtifactDocName,
  LEGACY_SKILL_STORE_ROOT,
  MANAGED_ARTIFACT_PREFIX_TEMPLATE,
  SYSTEM_DOC_NAME,
  templateContentDocName,
} from './constants/cc1.ts';
export {
  SIDEBAR_BG_DARK,
  SIDEBAR_BG_LIGHT,
} from './constants/chrome.ts';
export { isEditableTextDocFile } from './constants/code-languages.ts';
export {
  DEFAULT_DOC_EXTENSION,
  type DocExtension,
  SUPPORTED_DOC_EXTENSIONS,
} from './constants/doc-extensions.ts';
export { LINEAGE_EPOCH_KEY } from './constants/doc-lifecycle.ts';
export { DOCUMENT_OPEN_BYTE_LIMIT } from './constants/document-open.ts';
export { UA_PATTERNS } from './constants/embedded-host.ts';
export {
  classifyGitHubShareHost,
  credentialHostFromRemoteUrl,
  DEFAULT_GITHUB_OAUTH_CLIENT_ID,
  declaredGitHubHostsFrom,
  gitCredentialHostKey,
  isGitCredentialHost,
  isGitHubHost,
  normalizeGitHostname,
} from './constants/github.ts';
export {
  isOrphanMode,
  ORPHAN_MODES,
  type OrphanMode,
} from './constants/graph.ts';
export {
  ACP_LAUNCH_FAILURE_LOG,
  DEFAULT_SIGTERM_GRACE_MS,
  PROJECT_DIAGNOSTIC_FILES,
  SERVER_CRASH_LOG,
  SERVER_EXIT_LOG,
  SPAWN_ERROR_LOG,
} from './constants/lifecycle.ts';
export {
  MCP_SERVER_NAME,
  OPEN_KNOWLEDGE_MCP_TOOLS,
  SERVER_TIMEOUT_ERROR_PREFIX,
  SERVER_UNREACHABLE_ERROR_PREFIX,
} from './constants/mcp.ts';
export {
  classifyMcpLauncherEntry,
  type McpLauncherDescriptor,
} from './constants/mcp-launcher.ts';
export { MENU_LABELS } from './constants/menu-labels.ts';
export {
  LOCAL_DIR,
  OK_DIR,
  OK_LEGACY_MACHINE_LOCAL_ROOT_DIRS,
  OK_MACHINE_LOCAL_ROOT_DIRS,
  OK_MACHINE_LOCAL_ROOT_FILES,
  OK_PROJECT_MARKER,
  OK_USER_HOME_CREDENTIAL_FILES,
  OK_USER_HOME_SECRETS_FILE,
  okUserHomeDisplayPath,
  SAVED_THEMES_DIRNAME,
  WORKTREES_DIRNAME,
} from './constants/ok-dir.ts';
export {
  PREVIEW_EMBED_STARTERS,
  previewEmbedFence,
} from './constants/preview-embed-starters.ts';
export { PREVIEW_THEME_TOKENS } from './constants/preview-theme-tokens.ts';
export {
  CHECKOUT_CLI_COMMAND,
  currentCliCommandName,
  currentDesktopProduct,
  DESKTOP_PRODUCTS,
  DEV_CHANNEL,
  DEV_FALLBACK_CLI_REFUSAL,
  type DesktopProduct,
  desktopChannelLabel,
  desktopWindowsExecutableName,
  envWithoutDevChannel,
  OkCliCommand,
  type OkCliRefusal,
  PACKAGED_DESKTOP_PRODUCT_NAMES,
  resolveDesktopProductName,
} from './constants/product.ts';
export { isReservedLogDoc } from './constants/reserved-docs.ts';
export { DEFAULT_SERVER_HOST } from './constants/server.ts';
export {
  MACHINE_ID_FILENAME,
  SERVER_AUTHORITY_LEASES_DIRNAME,
  SERVER_AUTHORITY_REGISTRY_FILENAME,
} from './constants/shared-ok-entries.ts';
export {
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_PDF_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  ASSET_EXTENSIONS,
  BESIDE_DOCUMENT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_DEDUP_MODE,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  type InlineAssetMediaKind,
  isExcalidrawDocFile,
  isMarkdownDocFile,
  isMermaidDocFile,
  LINKABLE_ASSET_EXTENSIONS,
  mediaKindForSidebarAssetExtension,
  SANDBOXED_HTML_CSP,
  SANDBOXED_HTML_EXTENSIONS,
} from './constants/upload.ts';
export {
  prependFrontmatter,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from './extensions/frontmatter.ts';
export { LinkFidelity } from './extensions/link-fidelity.ts';
export { MathInline } from './extensions/math-inline.ts';
export { sharedExtensions } from './extensions/shared.ts';
export {
  getWikiLinkText,
  parseWikiLink,
  WikiLink,
} from './extensions/wiki-link.ts';
/**
 * The re-exported attrs are schema-add-only per precedent #9, so this public import path
 * commits to additive evolution only.
 */
export { parseFrontmatterRecord } from './frontmatter/record.ts';
export {
  type FrontmatterMap,
  type FrontmatterPatch,
  type FrontmatterType,
  type FrontmatterValue,
  FrontmatterValueSchema,
  frontmatterRecord,
  isFrontmatterValueEmpty,
} from './frontmatter/schema.ts';
export { extractFrontmatterTags } from './frontmatter/tags.ts';
export {
  parseFrontmatterYaml,
  serializeFrontmatterMap,
  withFences,
} from './frontmatter/yaml-codec.ts';
export {
  diffFrontmatter,
  type FrontmatterDelta,
  type PropertyChange,
} from './frontmatter-diff.ts';
export { augmentGitSpawnPath } from './git/git-spawn-path.ts';
export type { WorktreeInventoryModel } from './git/worktree-inventory-model.ts';
export type { WorktreeSelectorModel } from './git/worktree-selector-model.ts';
export {
  pathspecArgs,
  stripPathspecMagic,
  toPathspec,
} from './git-pathspec.ts';
export {
  AUTO_DETECTABLE_LOCALES,
  LAYOUT_DEFERRED_LOCALES,
  type LanguagePreference,
  PICKER_LOCALES,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './i18n/locales.ts';
export {
  FALLBACK_LOCALE,
  type LocaleSource,
  resolveLocale,
} from './i18n/resolve-locale.ts';
export type {
  BundleManifest,
  BundleRedaction,
  Loggable,
  OkBugReportCreateResult,
  ReportBundleLevel,
  ReportBundleSummary,
  SerializedError,
  SerializedErrorTruncation,
} from './logger-types.ts';
export {
  RENDERER_LOG_MAX_BATCH_BYTES,
  RENDERER_LOG_MAX_ENTRIES,
  RENDERER_LOG_MAX_MESSAGE_BYTES,
} from './logging/renderer-log.ts';
export {
  redactSecrets,
  SECRET_PATTERN_NAMES,
  scrubSecrets,
} from './logging/secret-scrub.ts';
export { MIN_CARRIED_TRAILING_EMPTIES } from './markdown/doc-edge-blank-runs.ts';
export { HtmlPayloadTooLargeError } from './markdown/html-to-mdast.ts';
export {
  MarkdownManager,
  type SerializeCallOptions,
} from './markdown/index.ts';
export {
  AUDIT_EMPTY_SCOPE_WARNING,
  applyFieldConstraint,
  CANONICAL_SCHEMA_DIALECT_URIS,
  canonicalRuleId,
  compileAppliesTo,
  countDiagnosticsBySource,
  DEFAULT_LINKS_VALIDATION,
  DEFAULT_LINTER_CONFIG,
  DEFAULT_MARKDOWNLINT_CONFIG,
  DEFAULT_SCHEMA_DIALECT,
  DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES,
  deriveValidationRunSources,
  emptyFrontmatterSchemaText,
  type FrontmatterFieldConstraint,
  FrontmatterSchemaEditError,
  type FrontmatterSchemaMapping,
  FrontmatterSchemasListSuccessSchema,
  FrontmatterSchemaWriteRequestSchema,
  findRuleConfigEntry,
  findZeroMatchAppliesToPatterns,
  fixDocument,
  frontmatterSchemaCompileError,
  isAuditEmptyScopeWarning,
  isFrontmatterSchemaAsset,
  isOkfRuleEnabled,
  isReLintFailedWarning,
  isReLintFailureReason,
  isSupportedSchemaDialect,
  LINT_PLUGIN_IDS,
  LINT_PLUGINS,
  type LinksValidationSetting,
  type LintAuditResponse,
  LintAuditResponseSchema,
  type LintConfigResponse,
  LintConfigResponseSchema,
  type LintDiagnostic,
  type LintDocResult,
  LintDocResultSchema,
  type LinterConfig,
  LintFixRequestSchema,
  type LintFixResult,
  LintFixResultSchema,
  type LintPluginFailure,
  type LintPluginId,
  type LintRange,
  type LintTextEdit,
  type LocalTargetDiagnosticEvidence,
  type LocalTargetSourceForm,
  lintDocument,
  MARKDOWNLINT_RULE_CATALOG,
  type MarkdownlintRuleSetting,
  MarkdownlintRuleWriteRequestSchema,
  OKF_FRONTMATTER_REGISTRY,
  OKF_RULE_GROUPS,
  OKF_RULE_IDS,
  OKF_SCHEMA_DIR,
  type OkfRuleId,
  type OkfRuleToggles,
  okfAdvertisedSchemaMappings,
  okfSchemaPathFor,
  type PersistedLinterConfig,
  RE_LINT_FAILED_WARNING_PREFIX,
  type ReLintFailure,
  ReLintFailureSchema,
  type ResolvedFrontmatterSchemaEntry,
  type RuleOptionSpec,
  removeSchemaField,
  renameSchemaField,
  renderOkfSchemaFiles,
  runOkfProjectRules,
  type SchemaParentPathSegment,
  SUPPORTED_SCHEMA_DIALECTS,
  selectAdvertisedFrontmatterMappings,
  summarizeLintPluginFailures,
  toEffectiveBase,
  VALIDATION_SOURCES,
  type ValidationAuditCountsResponse,
  ValidationAuditCountsResponseSchema,
  type ValidationAuditResponse,
  ValidationAuditResponseSchema,
  type ValidationDiagnostic,
  type ValidationDocCounts,
  type ValidationDocResult,
  type ValidationSource,
  validationCoverageLines,
} from './markdown/lint/index.ts';
export {
  markdownToHtml,
  mdastToHtml,
} from './markdown/mdast-to-html.ts';
export {
  maskNonRenderingContextLines,
  skipInlineCode,
} from './markdown/non-rendering-contexts.ts';
export { isMutatingParserReservation } from './markdown/parser-reservations.ts';
export { normalizeReferenceLabel } from './markdown/reference-label.ts';
export { normalizeDocRelativeAssetUrl } from './markdown/resolve-image-url.ts';
export { SAFE_URL_SCHEMES } from './markdown/safe-url.ts';
export { createTagInTextRegex } from './markdown/tag-promotion.ts';
export {
  type CleanWikiSegments,
  normalizeWikiSeparatorEscapes,
  rawSegmentOr,
} from './markdown/wiki-escape.ts';
export {
  getParseHealth,
  resetParseHealth,
} from './metrics/parse-health.ts';
export { PROTOCOL_VERSION } from './protocol-version.ts';
export {
  builtInComponents,
  type ComponentRegistry,
  createRegistry,
  propDescription,
  wildcardMeta,
} from './registry/index.ts';
export {
  JSX_SRC_REF_TAGS,
  type JsxSrcRefTagSpec,
} from './registry/jsx-src-ref-tags.ts';
export {
  type ComponentEntryFull,
  getAgentCanonicalDescriptors,
  getCanonicalDescriptors,
  projectFull,
} from './registry/projection.ts';
export type { PropDef } from './registry/types.ts';
export {
  ActivityAgentHeaderSchema,
  ActivityBurstSchema,
  ActivityFileSchema,
  type AdvisoryWarning,
  AdvisoryWarningSchema,
  AGENT_WRITE_BATCH_MAX_DOCS,
  AGENT_WRITE_NEXT_STEP_MEANINGS,
  AGENT_WRITE_NEXT_STEPS,
  AGENT_WRITE_OUTCOME_MEANINGS,
  AGENT_WRITE_OUTCOMES,
  AgentActivitySuccessSchema,
  AgentBurstDiffSuccessSchema,
  AgentPatchRequestSchema,
  AgentPatchSuccessSchema,
  AgentPresenceEntrySchema,
  AgentUndoRequestSchema,
  AgentUndoSuccessSchema,
  AgentWriteBatchRequestSchema,
  AgentWriteBatchResultSchema,
  AgentWriteBatchSuccessSchema,
  type AgentWriteMdRequest,
  AgentWriteMdRequestSchema,
  AgentWriteMdSuccessSchema,
  type AgentWriteOutcomeFields,
  AgentWriteRequestSchema,
  AgentWriteSuccessSchema,
  ApiConfigSuccessSchema,
  type AttachmentFolderUploadIssue,
  assertNeverProblemType,
  assertNeverSemanticQueryOutcome,
  assertNeverWriteWarning,
  BacklinkCountsSuccessSchema,
  BacklinkEntrySchema,
  BacklinksSuccessSchema,
  type BatchEntryError,
  BROKEN_LINK_SUPPRESSION_REASONS,
  type BranchInfoResponse,
  BranchInfoResponseSchema,
  type BrokenLink,
  type BrokenLinkReason,
  BrokenLinkSchema,
  type BrokenLinkSuppression,
  type BrokenLinkSuppressionReason,
  BrokenLinkSuppressionSchema,
  type CheckoutFailureReason,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  type ClassifiedGitAuthError,
  ClientLogsRequestSchema,
  ClientLogsSuccessSchema,
  CONFLICT_KINDS,
  ConflictEntrySchema,
  type ConflictEntryWire,
  type ContentDivergenceCurrentState,
  type ContentDivergenceWarning,
  ContentDivergenceWarningSchema,
  CreateFolderRequestSchema,
  CreateFolderSuccessSchema,
  CreatePageRequestSchema,
  CreatePageSuccessSchema,
  canonicalTemplateName,
  classifyGitAuthError,
  classifySemanticProviderError,
  DeadLinkEntrySchema,
  DeadLinkSourceSchema,
  DeadLinksSuccessSchema,
  DeletePathRequestSchema,
  DeletePathSuccessSchema,
  type DiskEditReconciledWarning,
  DismissDocNoticeRequestSchema,
  DismissDocNoticeSuccessSchema,
  DocNoticesSuccessSchema,
  type DocNoticeWire,
  DocNoticeWireSchema,
  type DocumentListEntry,
  DocumentListEntrySchema,
  DocumentListSuccessSchema,
  DocumentReadSuccessSchema,
  DocumentRefreshRequestSchema,
  DocumentRefreshSuccessSchema,
  DuplicatePathRequestSchema,
  DuplicatePathSuccessSchema,
  EmbedDetectSuccessSchema,
  EmptyRequestSchema,
  FolderConfigGetSuccessSchema,
  FolderConfigPutRequestSchema,
  FolderConfigPutSuccessSchema,
  type FolderConfigWarningCode,
  ForwardLinkDocEntrySchema,
  ForwardLinkEntrySchema,
  ForwardLinkExternalEntrySchema,
  type ForwardLinkLocalTarget,
  ForwardLinkLocalTargetSchema,
  type ForwardLinksSuccess,
  ForwardLinksSuccessSchema,
  FrontmatterPatchRequestSchema,
  FrontmatterPatchSuccessSchema,
  findTemplateByName,
  GIT_STATUS_CODES,
  type GitAuthFailureSubclass,
  type GitHubReferencePreview,
  GitHubReferencePreviewSchema,
  GitHubReferenceRequestSchema,
  GitHubReferenceResponseSchema,
  type GitStatusCode,
  type GitWorktreeEntry,
  type GitWorktreeOpenTarget,
  GitWorktreeStatusSuccessSchema,
  HistorySuccessSchema,
  HistoryVersionSuccessSchema,
  HubEntrySchema,
  HubsSuccessSchema,
  InstalledAgentsSuccessSchema,
  isBranchNotFoundGitError,
  isLoginFixableGitAuthError,
  isReconcileMergeOutcome,
  isSemanticSearchOffered,
  isValidBranchName,
  isWriteWarningKind,
  type LifecycleStatus,
  type LinkCheckDeferredWarning,
  LinkGraphDocNodeSchema,
  LinkGraphEdgeSchema,
  LinkGraphExternalNodeSchema,
  LinkGraphNodeSchema,
  LinkGraphSuccessSchema,
  type LinkPreviewMetadata,
  LinkPreviewMetadataSchema,
  LinkPreviewRequestSchema,
  LinkPreviewResponseSchema,
  type LintViolationWarning,
  LintViolationWarningSchema,
  LocalOpAuthCancelRequestSchema,
  LocalOpAuthEmptySuccessSchema,
  type LocalOpAuthHostRequest,
  LocalOpAuthHostRequestSchema,
  LocalOpAuthPatRequestSchema,
  LocalOpAuthPatSuccessSchema,
  LocalOpAuthSetIdentityRequestSchema,
  LocalOpAuthStatusSuccessSchema,
  LocalOpAuthTokenRequestSchema,
  LocalOpAuthTokenSuccessSchema,
  type LocalOpCloneRequest,
  LocalOpCloneRequestSchema,
  LocalOpEmbeddingsMutationSuccessSchema,
  LocalOpEmbeddingsSetKeyRequestSchema,
  type LocalOpEmbeddingsTestResponse,
  LocalOpEmbeddingsTestResponseSchema,
  LocalOpOkInitRequestSchema,
  LocalOpOkInitResponseSchema,
  LocalTargetDiagnosticEvidenceSchema,
  type MetricsAgentEffectsSuccess,
  MetricsAgentEffectsSuccessSchema,
  MetricsAgentPresenceSuccessSchema,
  MetricsParseHealthSuccessSchema,
  MetricsReconciliationSuccessSchema,
  type MetricsWatcherRecentSuccess,
  MetricsWatcherRecentSuccessSchema,
  type NormalizedAgentWriteOutcome,
  normalizeAgentWriteOutcome,
  OrphanEntrySchema,
  OrphansSuccessSchema,
  PageEntrySchema,
  PageHeadingsSuccessSchema,
  PagesSuccessSchema,
  PrincipalSuccessSchema,
  type ProblemDetails,
  ProblemDetailsSchema,
  type ProblemType,
  ProblemTypeSchema,
  type PullOutcome,
  PullOutcomeSchema,
  PushPermissionSchema,
  RECONCILE_REASONS,
  REFUSED_SYMLINK_PATHS_CAP,
  RESOLVE_STRATEGIES,
  type ReconcileMergeOutcome,
  RenamedDocMappingSchema,
  RenamePathRequestSchema,
  RenamePathSuccessSchema,
  RenameRewrittenDocSchema,
  type RenderWarning,
  type RescueEntryFlat,
  type RescueEntryTimeline,
  RescueListSuccessSchema,
  RollbackRequestSchema,
  RollbackSuccessSchema,
  SavedThemeDeleteSuccessSchema,
  SavedThemeSaveRequestSchema,
  SavedThemeSaveSuccessSchema,
  SavedThemesListSuccessSchema,
  SavedThemeUpdateRequestSchema,
  SavedThemeUpdateSuccessSchema,
  SaveVersionRequestSchema,
  SaveVersionSuccessSchema,
  SearchRequestSchema,
  type SearchSemanticStatus,
  SearchSemanticStatusSchema,
  type SearchSource,
  type SearchSuccess,
  SearchSuccessSchema,
  SeedApplyRequestSchema,
  SeedApplySuccessSchema,
  SeedListPacksSuccessSchema,
  SeedPlanSuccessSchema,
  type SemanticIndexStatus,
  SemanticIndexStatusSchema,
  type SemanticProviderErrorReason,
  SemanticProviderErrorReasonSchema,
  type SemanticQueryOutcome,
  SemanticQueryOutcomeSchema,
  ServerInfoBootSchema,
  ServerInfoSuccessSchema,
  type ShareConstructUrlErrorCode,
  ShareConstructUrlErrorCodeSchema,
  ShareConstructUrlRequestSchema,
  type ShareConstructUrlResponse,
  ShareConstructUrlResponseSchema,
  type ShareFreshness,
  ShareFreshnessSchema,
  type SharePublishErrorCode,
  type SharePublishNameCheckResponse,
  SharePublishNameCheckResponseSchema,
  type SharePublishOwner,
  type SharePublishOwnersErrorCode,
  type SharePublishOwnersResponse,
  SharePublishOwnersResponseSchema,
  SharePublishRequestSchema,
  type SharePublishResponse,
  SharePublishResponseSchema,
  ShareTargetStatusRequestSchema,
  type ShareTargetStatusResponse,
  ShareTargetStatusResponseSchema,
  type StreamingProblemEvent,
  StreamingProblemEventSchema,
  SuggestLinksMentionSchema,
  SuggestLinksSuccessSchema,
  SuggestLinksTargetSchema,
  SummaryResponseFieldSchema,
  SyncConflictContentSuccessSchema,
  SyncConflictsSuccessSchema,
  type SyncErrorCode,
  SyncModeSchema,
  SyncRemoteSchema,
  SyncResolveBlockingRequestSchema,
  SyncResolveBlockingSuccessSchema,
  SyncResolveConflictRequestSchema,
  SyncResolveConflictSuccessSchema,
  SyncStateSchema,
  SyncStatusSchema,
  SyncTriggerRequestSchema,
  SyncTriggerSuccessSchema,
  semanticProviderErrorBlocks,
  TagsForNameSuccessSchema,
  TagsListSuccessSchema,
  TEMPLATE_NAME_REGEX,
  TEMPLATE_NAME_RULE,
  TemplateDeleteSuccessSchema,
  TemplateGetSuccessSchema,
  TemplateImportRequestSchema,
  TemplateImportSuccessSchema,
  TemplateMoveRequestSchema,
  TemplateMoveSuccessSchema,
  TemplatePutRequestSchema,
  TemplatePutSuccessSchema,
  type TemplatesListEntry,
  type TemplatesListSuccess,
  TemplatesListSuccessSchema,
  TestFlushGitSuccessSchema,
  TestRescanBacklinksSuccessSchema,
  TestRescanFilesSuccessSchema,
  TestResetSuccessSchema,
  TrashCleanupRequestSchema,
  TrashCleanupSuccessSchema,
  UNREADABLE_WARNINGS_TEXT,
  UploadAssetSuccessSchema,
  type UploadRequest,
  UploadRequestSchema,
  WorkspaceSuccessSchema,
  WRITE_WARNING_KINDS,
  type WriteWarning,
} from './schemas/api/index.ts';
export {
  CC1_CHANNEL_BRANCH_SWITCHED,
  CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
  CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
  CC1_CHANNEL_DISK_ACK,
  CC1_CHANNEL_SERVER_INFO,
  CC1BranchSwitchedPayloadSchema,
  type CC1Channel,
  CC1ConfigIgnoreNestedErrorPayloadSchema,
  CC1ConfigValidationRejectedPayloadSchema,
  type CC1DerivedViewPayload,
  CC1DerivedViewPayloadSchema,
  CC1DiskAckPayloadSchema,
  CC1ServerInfoPayloadSchema,
  type DerivedViewChannel,
} from './schemas/cc1.ts';
export {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  DEFAULT_RRF_K,
  searchWorkspaceCorpus,
  updateWorkspaceSearchCorpus,
  type WorkspaceSearchCorpus,
  type WorkspaceSearchDocument,
  type WorkspaceSearchIntent,
  type WorkspaceSearchRanking,
  type WorkspaceSearchResult,
  type WorkspaceSearchScope,
  type WorkspaceSemanticInput,
} from './search/workspace-search.ts';
export { planHasOutstandingWork } from './seed-plan-work.ts';
export {
  decodeShareUrl,
  encodeShareUrl,
  InvalidShareUrlError,
  parseCanonicalGitHubShareUrl,
} from './sharing/index.ts';
export {
  SYNC_PAUSED_REASONS,
  type SyncPausedReason,
} from './sync-paused-reason.ts';
export {
  composeTemplateFile,
  instantiateDoc,
  parseTemplateFile,
  TEMPLATE_IDENTITY_KEY,
  type TemplateIdentity,
} from './templates/template-format.ts';
export { TEST_LOOP_CORE_MARKER } from './test-loop-marker.ts';
export type {
  Base16ParseError,
  Base16Scheme,
  Base16Slot,
} from './theme/base16.ts';
export {
  BASE16_SLOT_ROLES,
  BASE16_SLOTS,
  base16ToTokens,
  base16ToYaml,
  parseBase16Scheme,
} from './theme/base16.ts';
export type { SavedThemeIdError } from './theme/theme-plugins.ts';
export {
  deriveSavedThemeId,
  deriveSavedThemeName,
  generateColorThemesCss,
  parseSavedThemeId,
  resolveThemePlugin,
} from './theme/theme-plugins.ts';
export type {
  AgentFocusEntry,
  AgentPresenceEntry,
} from './types/awareness.ts';
export type { Identity } from './types/identity.ts';
export type { Principal } from './types/principal.ts';
export type {
  EntryType,
  ShadowContributor,
  TimelineEntry,
} from './types/timeline.ts';
export {
  isHiddenDocName,
  isProjectSkillBundlePath,
  validateDocName,
} from './util/doc-name.ts';
export {
  ChunkedInsertError,
  chunkedYTextInsert,
} from './utils/chunked-insert.ts';
export { createCodeFenceTracker } from './utils/code-fence-tracker.ts';
export { formatFileSize } from './utils/file-size.ts';
export { scanHeadingLine } from './utils/heading-scan.ts';
export {
  AGENT_ICON_COLORS,
  colorFromSeed,
  displayNameFromClientName,
  HUMAN_COLORS,
  iconFromClientName,
  SYSTEM_WRITER_DISPLAY_NAMES,
} from './utils/identity.ts';
export {
  assertNeverLinkTarget,
  classifyMarkdownHref,
  classifyWikiLinkTarget,
  isExternalHref,
  resolveAssetProjectPath,
} from './utils/link-targets.ts';
export { localIsoDate } from './utils/local-iso-date.ts';
export {
  type BasenameIndex,
  createBasenameIndex,
} from './utils/path-resolve.ts';
export {
  formatRelativeAge,
  RELATIVE_TIME_UNKNOWN,
} from './utils/relative-time.ts';
export {
  decodeHrefPath,
  encodeHrefPath,
  encodeHrefPathSegment,
  resolveInternalHref,
} from './utils/resolve-internal-href.ts';
export { shellSingleQuote } from './utils/shell-quote.ts';
export { sleep } from './utils/sleep.ts';
export {
  type HeadingEntry,
  toWikiLinkSlug,
} from './utils/slug.ts';
export {
  expandTagToHierarchy,
  tagsMatchingPrefix,
} from './utils/tag-rollup.ts';
export {
  type DependencySlug,
  dependencySlug,
  type IdentityKey,
  identityKey,
  leafKey,
  wikiAssetPathKey,
} from './utils/target-identity.ts';
export {
  addDocumentFolders,
  asTargetNamespace,
  createTargetNamespace,
  type MutableTargetNamespace,
  resolveName,
  type TargetNamespace,
} from './utils/target-namespace.ts';
export {
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  createWikiAssetResolver,
  resolveWikiLinkTarget,
  resolveWikiLinkTargetDocName,
  type WikiLinkLookupIndex,
} from './utils/wiki-link-resolve.ts';
