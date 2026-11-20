const APP_ICON_FILES = new Set([
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
]);
const APP_ICON_DIR_RE = /^\/icons\/[a-z0-9-]+\.(?:png|svg)$/;

export function isAppIconPath(path: string): boolean {
  return APP_ICON_FILES.has(path) || APP_ICON_DIR_RE.test(path);
}
