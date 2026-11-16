import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { topLevelFrontmatterRecord } from '../../frontmatter/schema.ts';
import { agentContentField, agentIdentityFields, summaryField } from './_shared.ts';
import { agentWriteOutcomeWireFields } from './agent-write-outcome.ts';
import { EmbeddingsKeyStoreErrorSchema } from './local-op.ts';

export const TagSummaryEntrySchema = z
  .object({
    name: z.string().min(1),
    count: z.number().int().nonnegative(),
    isLeaf: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type TagSummaryEntry = z.infer<typeof TagSummaryEntrySchema>;

export const TagsListSuccessSchema = z
  .object({
    tags: z.array(TagSummaryEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type TagsListSuccess = z.infer<typeof TagsListSuccessSchema>;

export const TagsDocEntrySchema = z
  .object({
    docName: z.string().min(1),
    title: z.string(),
    matchingTags: z.array(z.string().min(1)),
    snippet: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type TagsDocEntry = z.infer<typeof TagsDocEntrySchema>;

export const TagsForNameSuccessSchema = z
  .object({
    name: z.string().min(1),
    docs: z.array(TagsDocEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type TagsForNameSuccess = z.infer<typeof TagsForNameSuccessSchema>;

export const FOLDER_CONFIG_WARNING_CODES = [
  'symlink-refused',
  'malformed-yaml',
  'unverifiable',
  'templates-symlink-refused',
  'templates-unverifiable',
] as const;
export type FolderConfigWarningCode = (typeof FOLDER_CONFIG_WARNING_CODES)[number];

export const FolderConfigGetSuccessSchema = z
  .object({
    folder: z.unknown(),
    frontmatter_local: z.record(z.string(), z.unknown()).nullable(),
    warnings: z.array(z.string()).optional().meta({
      description:
        'Non-fatal degradations of this response, one per entry; the field each affects is absent, null, or incomplete — the aligned `warningCodes` entry names which field and how.',
    }),
    warningCodes: z.array(z.enum(FOLDER_CONFIG_WARNING_CODES)).optional().meta({
      description:
        "Machine-readable codes aligned 1:1 with `warnings`; switch on these, never on the English. `symlink-refused` / `malformed-yaml` / `unverifiable`: this folder's own `.gitquire/frontmatter.yml` (a symlink, malformed YAML, or an lstat failure) — `frontmatter_local` is null. `templates-symlink-refused` / `templates-unverifiable`: the `.gitquire/templates` directory on this folder, or a `.gitquire` or `.gitquire/templates` directory on an ancestor it inherits from — a symlink (wherever it points, dangling included), or a non-ENOTDIR `lstat` failure — `folder.templates_available` omits that directory's templates and may still list others. A non-directory `.gitquire` / `.gitquire/templates` (ENOTDIR) is treated as empty and yields no `templates-*` code. This folder's own symlinked `.gitquire` is a 400, never a warning.",
    }),
  })
  .loose() satisfies StandardSchemaV1;
export type FolderConfigGetSuccess = z.infer<typeof FolderConfigGetSuccessSchema>;

export const FolderConfigPutRequestSchema = z
  .object({
    path: z.string(),
    frontmatter: topLevelFrontmatterRecord(z.unknown()).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type FolderConfigPutRequest = z.infer<typeof FolderConfigPutRequestSchema>;

export const FolderConfigPutSuccessSchema = z
  .object({
    applied: z.unknown(),
  })
  .loose() satisfies StandardSchemaV1;
export type FolderConfigPutSuccess = z.infer<typeof FolderConfigPutSuccessSchema>;

export const TemplateFrontmatterSchema = z
  .record(z.string(), z.unknown())
  .meta({ description: 'Free-form frontmatter map embedded in template payloads.' });
export type TemplateFrontmatter = z.infer<typeof TemplateFrontmatterSchema>;

export const TemplatePayloadSchema = z
  .object({
    name: z.string().min(1),
    folder: z.string(),
    scope: z.enum(['local', 'inherited']),
    path: z.string().min(1),
    frontmatter: TemplateFrontmatterSchema,
    body: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatePayload = z.infer<typeof TemplatePayloadSchema>;

export const TemplateGetSuccessSchema = z
  .object({
    template: TemplatePayloadSchema,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateGetSuccess = z.infer<typeof TemplateGetSuccessSchema>;

export const TemplatesListEntrySchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    path: z.string().min(1),
    source_folder: z.string(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatesListEntry = z.infer<typeof TemplatesListEntrySchema>;

export const TemplatesListSuccessSchema = z
  .object({
    templates: z.array(TemplatesListEntrySchema),
    truncated: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatesListSuccess = z.infer<typeof TemplatesListSuccessSchema>;

export const TemplatePutRequestSchema = z
  .object({
    folder: z.string(),
    name: z.string(),
    body: agentContentField.optional(),
    frontmatter: TemplateFrontmatterSchema.optional(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatePutRequest = z.infer<typeof TemplatePutRequestSchema>;

export const TemplatePutSuccessSchema = z
  .object({
    ...agentWriteOutcomeWireFields,
    path: z.string().min(1),
    created: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplatePutSuccess = z.infer<typeof TemplatePutSuccessSchema>;

export const TemplateImportRequestSchema = z
  .object({
    sourcePath: z.string().min(1),
    targetFolder: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    deleteSource: z.boolean().optional(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateImportRequest = z.infer<typeof TemplateImportRequestSchema>;

export const TemplateImportSuccessSchema = z
  .object({
    ...agentWriteOutcomeWireFields,
    path: z.string().min(1),
    created: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateImportSuccess = z.infer<typeof TemplateImportSuccessSchema>;

export const TemplateDeleteSuccessSchema = z
  .object({
    existed: z.boolean(),
    path: z.string().min(1),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateDeleteSuccess = z.infer<typeof TemplateDeleteSuccessSchema>;

export const TemplateMoveRequestSchema = z
  .object({
    fromFolder: z.string(),
    fromName: z.string(),
    toFolder: z.string(),
    toName: z.string(),
    body: agentContentField.optional(),
    frontmatter: TemplateFrontmatterSchema.optional(),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateMoveRequest = z.infer<typeof TemplateMoveRequestSchema>;

export const TemplateMoveSuccessSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    committed: z.boolean(),
  })
  .strict() satisfies StandardSchemaV1;
export type TemplateMoveSuccess = z.infer<typeof TemplateMoveSuccessSchema>;

const XML_TAG_REGEX = /<\/?[A-Za-z][^>]*>/;
export function containsXmlTag(s: string): boolean {
  return XML_TAG_REGEX.test(s);
}

export const TEMPLATE_NAME_REGEX = /^(?:(?!\p{DI})[\p{L}\p{M}\p{N}_-])+$/u;

export const TEMPLATE_NAME_RULE =
  'letters and digits in any script, `_` or `-` only (no spaces, dots, slashes or invisible characters)';

export function canonicalTemplateName(name: string): string {
  return name.normalize('NFC');
}

export function templateRenameTarget(storedName: string, draft: string): string | null {
  const trimmed = draft.trim();
  if (trimmed === storedName) return null;
  const target = canonicalTemplateName(trimmed);
  return target === storedName ? null : target;
}

export function findTemplateByName<T extends { name: string }>(
  templates: readonly T[],
  requested: string,
): T | undefined {
  const key = canonicalTemplateName(requested);
  return (
    templates.find((t) => t.name === requested) ??
    templates.find((t) => canonicalTemplateName(t.name) === key)
  );
}

export const UNREADABLE_WARNINGS_TEXT =
  'The server reported warnings in a shape this build does not recognise; treat this result as unverified.';

export function normalizeApiWarnings(value: unknown): string[] {
  if (value === undefined) return [];
  const unreadable = UNREADABLE_WARNINGS_TEXT;
  if (!Array.isArray(value)) return [unreadable];
  const warnings = value.filter((entry): entry is string => typeof entry === 'string');
  return warnings.length === value.length ? warnings : [...warnings, unreadable];
}

export const SearchRequestSchema = z
  .object({
    query: z.string().optional(),
    intent: z.enum(['autocomplete', 'full_text', 'omnibar']).optional(),
    ranking: z.enum(['navigation', 'relevance']).optional(),
    scopes: z.array(z.enum(['page', 'folder', 'content', 'file'])).optional(),
    scope: z.string().optional(),
    limit: z.number().int().nonnegative().optional(),
    semantic: z.boolean().optional(),
    source: z.enum(['omnibar', 'mcp', 'http']).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export type SearchSource = NonNullable<SearchRequest['source']>;

export const SearchResultEntrySchema = z
  .object({
    kind: z.enum(['page', 'folder', 'content', 'file']),
    path: z.string().min(1),
    title: z.string(),
    score: z.number(),
    signals: z.record(z.string(), z.unknown()),
    snippet: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchResultEntry = z.infer<typeof SearchResultEntrySchema>;

export const SemanticQueryOutcomeSchema = z.enum([
  'applied',
  'no_match',
  'warming',
  'incapable',
  'provider_error',
  'restart_required',
  'query_too_short',
]);
export type SemanticQueryOutcome = z.infer<typeof SemanticQueryOutcomeSchema>;

export const SemanticProviderErrorReasonSchema = z.enum([
  'warm',
  'corpus',
  'query',
  'dimensions',
  'configured_dimensions',
]);
export type SemanticProviderErrorReason = z.infer<typeof SemanticProviderErrorReasonSchema>;

export type SemanticProviderFailureOutcome = Extract<
  SemanticQueryOutcome,
  'incapable' | 'provider_error' | 'restart_required'
>;

export function classifySemanticProviderError(
  status: Pick<SemanticIndexStatus, 'providerError' | 'providerErrorReason'> | null | undefined,
): SemanticProviderFailureOutcome | null {
  if (status?.providerErrorReason === 'dimensions') return 'restart_required';
  if (status?.providerErrorReason === 'configured_dimensions') return 'incapable';
  if (status?.providerError || status?.providerErrorReason) return 'provider_error';
  return null;
}

export function assertNeverSemanticProviderErrorReason(value: never): never {
  throw new Error(
    `Unhandled SemanticProviderErrorReason variant: ${JSON.stringify(value as unknown)}`,
  );
}

export function semanticProviderErrorBlocks(
  status: Pick<SemanticIndexStatus, 'providerError' | 'providerErrorReason'> | null | undefined,
  phase: 'probe' | 'query',
): boolean {
  const reason = status?.providerErrorReason;
  switch (reason) {
    case null:
    case undefined:
      return status?.providerError === true;
    case 'corpus':
      return false;
    case 'query':
      return phase === 'query';
    case 'warm':
    case 'dimensions':
    case 'configured_dimensions':
      return true;
    default:
      return assertNeverSemanticProviderErrorReason(reason);
  }
}

export function assertNeverSemanticQueryOutcome(value: never): never {
  throw new Error(`Unhandled SemanticQueryOutcome variant: ${JSON.stringify(value as unknown)}`);
}

export const SearchSemanticStatusSchema = z
  .object({
    capable: z.boolean(),
    applied: z.boolean(),
    outcome: SemanticQueryOutcomeSchema,
    providerErrorReason: SemanticProviderErrorReasonSchema.nullable().optional().catch(null),
    coverage: z.object({
      embedded: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchSemanticStatus = z.infer<typeof SearchSemanticStatusSchema>;

export const SemanticIndexStatusSchema = z
  .object({
    enabled: z.boolean(),
    keyPresent: z.boolean(),
    keyStoreUnavailable: z.boolean().optional(),
    keyStoreError: EmbeddingsKeyStoreErrorSchema.optional().catch(undefined),
    keyStoredInFile: z.boolean().optional(),
    keyNotRequired: z.boolean(),
    keySource: z.enum(['project', 'file', 'env']).nullable(),
    keyHint: z.string().nullable(),
    ready: z.boolean(),
    capable: z.boolean(),
    providerError: z.boolean().optional(),
    providerErrorReason: SemanticProviderErrorReasonSchema.nullable().optional().catch(null),
    embedded: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type SemanticIndexStatus = z.infer<typeof SemanticIndexStatusSchema>;

export function isSemanticSearchOffered(
  status: Pick<SemanticIndexStatus, 'enabled' | 'keyPresent' | 'keyNotRequired'> | null | undefined,
): boolean {
  return Boolean(status?.enabled && (status.keyPresent || status.keyNotRequired));
}

export const SearchSuccessSchema = z
  .object({
    query: z.string(),
    intent: z.enum(['autocomplete', 'full_text', 'omnibar']),
    results: z.array(SearchResultEntrySchema),
    elapsedMs: z.number().nonnegative(),
    semantic: SearchSemanticStatusSchema.optional(),
    truncated: z.boolean().optional(),
    ready: z.boolean().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SearchSuccess = z.infer<typeof SearchSuccessSchema>;
