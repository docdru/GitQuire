export function isOkDesktopHost(): boolean {
  return typeof window !== 'undefined' && window.okDesktop != null;
}

export function isSpellcheckLanguageSelectionAvailable(): boolean {
  return isOkDesktopHost() && window.okDesktop?.platform !== 'darwin';
}
