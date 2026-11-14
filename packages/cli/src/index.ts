export {
  detectGh,
  detectGhAccounts,
  type GhAccount,
  type GhDetectResult,
} from './auth/gh-detect.ts';
export {
  createTokenStore,
  makeLazyProbeTokenStore,
  type TokenStore,
} from './auth/token-store.ts';
export {
  type BundleExtraFile,
  type BundleLogger,
  defaultBugReportZipPath,
  okBugReportsDir,
} from './commands/bug-report-bundle.ts';
export { redactContent } from './commands/bug-report-redact.ts';
export { runStop } from './commands/stop.ts';
export { type LoadConfigResult, loadConfig } from './config/loader.ts';
export { type PreviewResult, previewContent } from './content/preview.ts';
export {
  findJetsamKillSync,
  type ProcessTerminationLookup,
  type ProcessTerminationQuery,
} from './diagnose/os-termination-evidence.ts';
export {
  type ExpectedShareRepo,
  type ShareFolderValidationResult,
  validateLocalFolderForShare,
} from './github/folder-validator.ts';
export {
  type ParsedGitHubBlobUrl,
  type ParsedGitHubShareTarget,
  type ParsedGitHubTreeUrl,
  parseGitHubBlobUrl,
  parseGitHubShareUrl,
  parseGitHubTreeUrl,
  parseGitUrl,
} from './github/url.ts';
export {
  PATH_SHIM_BEGIN,
  PATH_SHIM_BLOCK_RE,
  PATH_SHIM_END,
  type PathDiscovery,
  type PathInstallConsent,
  type PathInstallMarker,
  pathInstallMarkerPath,
} from './integrations/path-shim.ts';
export {
  type ResolveProjectRootOptions,
  type ResolveProjectRootResult,
  resolveProjectRoot,
} from './integrations/resolve-project-root.ts';
export {
  type CollectReportBundleOptions,
  collectReportBundle,
  type ReportBundleLevel,
  type ReportBundleResult,
  type ReportBundleSummary,
} from './report-bundle.ts';
export type { LanguageMetadata } from './report-language.ts';
export {
  addOkPathsToGitExclude,
  type ExcludeWriteResult,
  formatTrackedRemediation,
  getExcludedOkPaths,
  getOkArtifactPaths,
  probeTrackedOkPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
  type SharingMode,
  type TrackedRefusal,
} from './sharing/git-exclude.ts';
