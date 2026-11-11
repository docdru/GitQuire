import { STABLE_DMG_URL } from './download-links';

export const SITE_URL = 'https://docdru.github.io/GitQuire';

export function absoluteSiteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
export const SITE_NAME = 'GitQuire';
export const TWITTER_HANDLE = '@OpenKnowledge';

export const GITHUB_URL = 'https://github.com/docdru/GitQuire';
export const UPSTREAM_URL = 'https://github.com/inkeep/open-knowledge';
export const DISCORD_URL = 'https://discord.gg/VRKk2EaGHN';
export const CHANGELOG_ROUTE = '/docs/changelog';
export const LEGAL_ROUTE = '/legal';
export const TERMS_OF_SERVICE_ROUTE = `${LEGAL_ROUTE}/self-serve-terms`;
export const PRIVACY_POLICY_ROUTE = `${LEGAL_ROUTE}/privacy-policy`;
export const CHANGELOG_TIMELINE_LIMIT = 30;
export const X_URL = `https://x.com/${TWITTER_HANDLE.slice(1)}`;
export const SITE_DESCRIPTION =
  'A self-hosted, collaborative WYSIWYG Markdown editor for small teams, with every page, link and comment stored in Git.';

export const SITE_HEADLINE = 'Collaborative Markdown pages, stored in Git.';

const DESCRIPTION_MAX = 160;

export function metaDescription(
  text: string | null | undefined,
  fallback: string = SITE_DESCRIPTION,
): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  const base = normalized.length > 0 ? normalized : fallback;
  if (base.length <= DESCRIPTION_MAX) return base;
  const slice = base.slice(0, DESCRIPTION_MAX - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > DESCRIPTION_MAX * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

export const DOWNLOAD_URL = STABLE_DMG_URL;

const DOWNLOAD_ROUTE = '/download/stable';

export type DownloadCta =
  | 'docs-content'
  | 'docs-sidebar'
  | 'continue-page'
  | 'share-splash-fallback'
  | 'share-splash';

export function downloadRouteForCta(cta: DownloadCta): string {
  return `${DOWNLOAD_ROUTE}?utm_content=${encodeURIComponent(cta)}`;
}
