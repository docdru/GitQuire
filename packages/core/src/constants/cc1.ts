export const SYSTEM_DOC_NAME = '__system__';
export const CC1_CONTRACT_VERSION = 1;

export const CONFIG_DOC_NAME_PROJECT = '__config__/project';

export const CONFIG_DOC_NAME_USER = '__user__/config.yml';

export const CONFIG_DOC_NAME_PROJECT_LOCAL = '__local__/project';

export const CONFIG_DOC_NAME_OKIGNORE = '__config__/okignore';

export const CONFIG_DOC_NAMES = Object.freeze([
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAME_OKIGNORE,
] as const);
export type ConfigDocName = (typeof CONFIG_DOC_NAMES)[number];

export const MANAGED_ARTIFACT_PREFIX_TEMPLATE = '__template__/';

export function isManagedArtifactDocName(name: string): boolean {
  return name.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE);
}

export const LEGACY_SKILL_STORE_ROOT = '.ok/skills';

export function stripMdExt(path: string): string {
  return path.replace(/\.mdx?$/i, '');
}

function decodeManagedSegments(encoded: string): string {
  if (encoded === '') return '';
  try {
    return encoded
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
  } catch {
    return encoded;
  }
}

const TEMPLATE_FILE_TARGET_RE = /^(?:(.+)\/)?\.ok\/templates\/([^/]+?)(?:\.md)?$/;

export type ParsedTemplateName = { folder: string; name: string };

export function templateContentDocName(folderRel: string, name: string): string {
  const folder = folderRel.replace(/^\/+|\/+$/g, '');
  return folder ? `${folder}/.ok/templates/${name}` : `.ok/templates/${name}`;
}

export function parseTemplateContentDocName(docName: string): ParsedTemplateName | null {
  const match = TEMPLATE_FILE_TARGET_RE.exec(docName);
  if (!match) return null;
  return { folder: (match[1] ?? '').replace(/^\/+|\/+$/g, ''), name: match[2] as string };
}

export function parseLegacyTemplateDocName(name: string): ParsedTemplateName | null {
  if (!name.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE)) return null;
  const rest = name.slice(MANAGED_ARTIFACT_PREFIX_TEMPLATE.length);
  if (!rest) return null;
  const lastSlash = rest.lastIndexOf('/');
  const encodedName = lastSlash < 0 ? rest : rest.slice(lastSlash + 1);
  if (!encodedName) return null;
  const encodedFolder = lastSlash < 0 ? '' : rest.slice(0, lastSlash);
  return {
    folder: decodeManagedSegments(encodedFolder),
    name: decodeManagedSegments(encodedName),
  };
}
