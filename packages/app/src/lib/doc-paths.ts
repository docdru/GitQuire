const MARKDOWN_EXTENSION = /\.(md|mdx)$/i;

function normalizeDocPathInput(value: string): string {
  return value
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

export function normalizeDocNameInput(value: string): string {
  return normalizeDocPathInput(value).replace(MARKDOWN_EXTENSION, '');
}

export function docNameToMarkdownPath(docName: string): string {
  const normalized = normalizeDocPathInput(docName);
  if (!normalized) return 'untitled.md';
  return MARKDOWN_EXTENSION.test(normalized) ? normalized : `${normalized}.md`;
}

export function docNameToDialogSeed(docName: string): {
  initialDir: string;
  suggestedName: string;
} {
  const normalized = normalizeDocNameInput(docName);
  const slash = normalized.lastIndexOf('/');
  return {
    initialDir: slash > 0 ? normalized.slice(0, slash) : '',
    suggestedName: `${slash >= 0 ? normalized.slice(slash + 1) : normalized || 'untitled'}.md`,
  };
}
