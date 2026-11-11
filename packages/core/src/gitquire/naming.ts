import { toWikiLinkSlug } from '../utils/slug.ts';

export type NamingRule = 'slug' | 'off';

const EXTENSION_RE = /^\.[a-z0-9]{1,8}$/;

export function parseNamingRule(value: string | undefined): NamingRule {
  return value?.trim().toLowerCase() === 'off' ? 'off' : 'slug';
}

function isExemptSegment(segment: string): boolean {
  return segment.startsWith('.') || segment.startsWith('_');
}

function slugOrKeep(text: string): string {
  const slug = toWikiLinkSlug(text);
  return slug === '' ? text : slug;
}

export function slugifySegment(segment: string, hasExtension: boolean): string {
  if (isExemptSegment(segment)) return segment;
  if (!hasExtension) return slugOrKeep(segment);
  const dot = segment.lastIndexOf('.');
  const extension = dot > 0 ? segment.slice(dot).toLowerCase() : '';
  if (!EXTENSION_RE.test(extension)) return slugOrKeep(segment);
  const stem = segment.slice(0, dot);
  return `${slugOrKeep(stem)}${extension}`;
}

export interface NamingOptions {
  rule: NamingRule;
  lastIsFile: boolean;
  keepFolder?: (folderPath: string) => boolean;
}

export function applyNamingRule(path: string, options: NamingOptions): string {
  if (options.rule === 'off') return path;
  const trailingSlash = path.endsWith('/');
  const segments = path.split('/').filter((segment) => segment !== '');
  const named: string[] = [];
  let original = '';
  segments.forEach((segment, index) => {
    original = original === '' ? segment : `${original}/${segment}`;
    const isLast = index === segments.length - 1;
    if (!isLast && options.keepFolder?.(original) === true) {
      named.push(segment);
      return;
    }
    named.push(slugifySegment(segment, isLast && options.lastIsFile));
  });
  const joined = named.join('/');
  return trailingSlash ? `${joined}/` : joined;
}

export function readableTitle(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const leaf = segments.at(-1) ?? '';
  const dot = leaf.lastIndexOf('.');
  const hasExtension = dot > 0 && EXTENSION_RE.test(leaf.slice(dot).toLowerCase());
  return (hasExtension ? leaf.slice(0, dot) : leaf).trim();
}

export function titleSeed(requestedPath: string, namedPath: string): string {
  if (requestedPath === namedPath) return '';
  const title = readableTitle(requestedPath);
  if (title === '' || title === readableTitle(namedPath)) return '';
  return `# ${title}\n`;
}
