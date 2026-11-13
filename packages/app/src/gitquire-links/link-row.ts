const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const NOISE_RE = /[\s\p{P}\p{S}]/gu;
const MIN_CONTEXT_CHARS = 3;

export function linkRowLocation(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined;
  if (URL_SCHEME_RE.test(path)) return path;
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? undefined : path.slice(0, slash);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function snippetAddsContext(
  snippet: string | null | undefined,
  mentions: readonly (string | undefined)[],
): boolean {
  if (snippet === null || snippet === undefined) return false;
  const words = new Set<string>();
  for (const mention of mentions) {
    if (mention === undefined || mention.trim() === '') continue;
    words.add(mention.trim());
    const slash = mention.lastIndexOf('/');
    if (slash !== -1) words.add(mention.slice(slash + 1));
  }
  let rest = snippet;
  for (const word of [...words].sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(escapeRegExp(word), 'gi'), ' ');
  }
  return rest.replace(NOISE_RE, '').length >= MIN_CONTEXT_CHARS;
}
