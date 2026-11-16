export {
  AUDIT_CONSOLE_RECORD_CASES,
  chromiumResourceFailureRecord,
} from './audit-console-records.test-helper.ts';
export {
  BORDER_SIDES,
  type BorderSide,
  type BorderSideName,
  type CardSurface,
  type ContrastPair,
  contrastRatioOf,
  countDifferingPixels,
  innerClipsOf,
  type RgbaBytes,
  readBorderColors,
  readCardSurface,
  readContrastPair,
  readRootColor,
  relativeLuminance,
  rgbaBytesOf,
  type ScreenClip,
  screenshotBrightness,
} from './card-surface.ts';
export { simulateCopyAndRead, simulateCutAndRead } from './clipboard.ts';
export { resetContentToFixtureBaseline } from './content-reset.ts';
export { expectDocumentOpen } from './document-open.ts';
export { afterEditorFocusSync, PROSEMIRROR_FOCUS_SYNC_DELAY_MS } from './editor-focus-sync.ts';
export {
  type CaretPlacement,
  focusEditor,
  placeCaretAtEndOfText,
  primeFullLayout,
  selectAllAndWaitForSelection,
  selectText,
  waitForPmSelectionInNode,
} from './editor-state.ts';
export { filterCriticalErrors, type LogEntry } from './error-filters.ts';
export {
  type ExternalLinkCue,
  externalLinkCueSnapshot,
  hasExternalCue,
} from './external-link-cue.ts';
export {
  type AgentIdentity,
  type ApiHelpers,
  expect,
  isConcurrentOverwriteRefusal,
  REQUIRED_FIXTURE_ENTRY_NAMES,
  test,
  type WorkerServer,
} from './fixtures.ts';
export { waitForGraphSimulationSettled } from './graph.ts';
export { waitForImageDecoded } from './image.ts';
export {
  assertLanded,
  CHUNK_WRAPPER_SELECTOR,
  injectForcedEstimateError,
  landingMarkCount,
  readEditorCaretLine,
  readSourceCaretHead,
  readWysiwygCaretHead,
  scrollWysiwygBlockToTop,
  TOOLBAR_OVERLAP_PX,
  toggleMode,
  waitForLandingSettled,
} from './landing.ts';
export {
  CHAT_PANE_CARD,
  DOCK_WORKSPACE,
  type DockSeamDrag,
  type DockUnitRect,
  dockSeam,
  dockUnit,
  dockUnitRect,
  dragDockSeam,
  EDITOR_PANE_CARD,
  expectDockUnitOff,
  expectEditorHidden,
  type HeaderPane,
  headerPaneButton,
  type LayoutViewport,
  openWebLayout,
  runPaletteCommand,
  setHeaderPane,
} from './pane-layout.ts';
export {
  appSourcesIn,
  servedEntryScriptRoute,
  servedModuleRoute,
  servedModuleUrl,
} from './prebuilt/served-modules.ts';
export { openPropPanel } from './prop-panel.ts';
export {
  installClockAfterSync,
  type WaitForProviderOptions,
  waitForActiveProviderSynced,
} from './provider.ts';
export { escapeRegExp } from './regexp.ts';
export { matchIsWithinReadableScrollport } from './scrollport.ts';
export {
  type BoundViteEndpoint,
  beginViteStartup,
  checkCollabSync,
  closeServerLog,
  createViteStartupRequest,
  getFreePort,
  killGracefully,
  openServerLog,
  prepareViteCacheDir,
  type ServerLog,
  tailServerLog,
  waitForBoundViteEndpoint,
  waitForHttpReady,
} from './server-process.ts';
export {
  openColorThemes,
  openProjectPluginsPanel,
  openSettingsSection,
  SETTINGS_PANEL_TIMEOUT_MS,
  setPluginEnabled,
  waitForSettingsPanel,
} from './settings.ts';
export {
  createFileViaSidebar,
  createFolderViaSidebar,
  expectActiveEditorTab,
} from './sidebar.ts';
export {
  getSelectedItemSnapshot,
  type SelectedItemSnapshot,
  type SlashMenuWaitOptions,
  slashMenu,
  waitForSlashMenuClosed,
  waitForSlashMenuFilteredBy,
  waitForSlashMenuFirstOption,
  waitForSlashMenuOpen,
} from './slash-menu.ts';
export {
  NEWSLETTER_KEY,
  NEWSLETTER_USED_UP,
  type NewsletterState,
  seedNewsletterStateBeforeLoad,
} from './subscribe-card.ts';
export { blockMarker, generateTallDoc } from './tall-doc-fixture.ts';
export { removeAllDuringTeardown } from './teardown-fs.ts';
export {
  type ArmedThemeFade,
  FADE_DURATION_MS,
  FADE_REPORT_WINDOW_MS,
  installThemeFadeProbe,
  runningRootAnimations,
  switchColorThemeAndSettleFade,
  type ThemeFadeProbeWindow,
  type ThemeFadeReport,
} from './theme-fade.ts';
export {
  createMp3Buffer,
  createMp4Buffer,
  createPngBuffer,
  uniqueAssetName,
} from './upload-fixtures.ts';
