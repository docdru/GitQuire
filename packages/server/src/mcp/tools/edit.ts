import { existsSync, readFileSync } from 'node:fs';
import { type FrontmatterPatch, stripFrontmatter, unwrapFrontmatterFences } from '@gitquire/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { formatBrokenLinkSuppressionLine } from '../../broken-link-suppression.ts';
import { resolveContentDir, resolveLockDir } from '../../config/paths.ts';
import { mergePatch } from '../../content/frontmatter-merge.ts';
import type { TemplateFrontmatter } from '../../content/templates-write.ts';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';
import type { AgentIdentity } from '../agent-identity.ts';
import {
  formatAdvisoryLines,
  formatBrokenLinkLines,
  parseAdvisoryWarnings,
  parseBrokenLinkSuppression,
  parseBrokenLinks,
} from './advisory-warnings.ts';
import { resolveWithinRoot } from './path-safety.ts';
import { buildPreviewAttachWarning, resolvePreviewUrl, startUiTextHint } from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  agentIdentityFields,
  CANONICAL_COMPONENT_GUIDANCE,
  documentResultBaseShape,
  errorTextWithDetail,
  hocuspocusNotRunningError,
  httpPost,
  httpPut,
  nestDocResult,
  normalizeDocName,
  okReservedPathRedirect,
  outputSchemaWithText,
  previewAttachWarningField,
  previewUrlOutputField,
  previewUrlSourceField,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  summaryArgSchema,
  textPlusStructured,
  textResult,
} from './shared.ts';
import {
  exactlyOneTargetError,
  FrontmatterArg,
  resolveTemplatePath,
  TEMPLATE_EDIT_CONTROL_ADVICE,
  TEMPLATE_METADATA_CONTROL_ADVICE,
  TEMPLATE_PATH_DESCRIBE,
} from './verb-schemas.ts';
import {
  failedWriteResult,
  landedLead,
  landedWithoutSuccess,
  leadFor,
  needsAttention,
  refusedDespiteSuccess,
  refusedWriteResult,
  type WriteOutcome,
  writeOutcomeFields,
  writeOutcomeLine,
  writeOutcomeOf,
  writeOutcomeOutputShape,
} from './write-outcome.ts';

const DESCRIPTION = [
  'Edit exactly one `document`, `folder`, or `template`: body find/replace OR metadata, never both in one call. Requires the Hocuspocus server.',
  '`document: {path, find, replace, occurrence?}` edits body only; frontmatter-intersecting finds are rejected. occurrence selects a match (1 = first). `{path, frontmatter}` merge-patches metadata; null deletes a key.',
  "`folder: {path, frontmatter}` patches metadata (no body). `template: {path: '<folder>/<name>', ...}` takes body find/replace/occurrence or frontmatter.",
  'Optional summary: one-line outcome ≤80 chars for any edit, persisted to git history; avoid secrets or PII.',
  'Follow nextStep (retry|re-read|none). merged-first, both-kept and projection-held landed: re-read, never retry. mermaid-parse-error: the edit landed; fix the fence.',
  CANONICAL_COMPONENT_GUIDANCE,
].join('\n');

interface EditDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
}

interface BodyEdit {
  find?: string;
  replace?: string;
  occurrence?: number;
}

function bodyOrFrontmatterError(
  t: BodyEdit & { frontmatter?: FrontmatterPatch },
  label: string,
): string | null {
  const hasBody = t.find !== undefined || t.replace !== undefined;
  const hasFm = t.frontmatter !== undefined;
  if (t.find !== undefined && t.replace === undefined) {
    return `\`find\` needs a \`replace\`. Body edit: { ${label}: { …, find, replace } }.`;
  }
  if (t.replace !== undefined && t.find === undefined) {
    return `\`replace\` needs a \`find\`. Body edit: { ${label}: { …, find, replace } }.`;
  }
  if (hasBody && hasFm) {
    return `Pick ONE: edit body text (find+replace) OR metadata (frontmatter), not both in one call.`;
  }
  if (!hasBody && !hasFm) {
    return `Provide either a body edit (find+replace) or a frontmatter patch for { ${label} }.`;
  }
  return null;
}

function readDocFullText(contentDir: string, docName: string): string | null {
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    const contained = resolveWithinRoot(contentDir, `${docName}${ext}`);
    if (contained.ok && existsSync(contained.abs)) {
      try {
        return readFileSync(contained.abs, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw err;
      }
    }
  }
  return null;
}

function nthOccurrenceOffset(text: string, find: string, occurrence: number): number {
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    const idx = text.indexOf(find, from);
    if (idx === -1) return -1;
    if (i === occurrence - 1) return idx;
    from = idx + Math.max(1, find.length);
  }
  return -1;
}

async function handleDocBody(
  doc: { path: string; find?: string; replace?: string; occurrence?: number },
  args: { summary?: string },
  cwd: string,
  contentDir: string,
  url: string,
  deps: EditDeps,
  autoOpen: boolean,
) {
  const normalized = normalizeDocName(doc.path);
  if (!normalized.ok) return textResult(okReservedPathRedirect(doc.path) ?? normalized.error, true);
  const identity = deps.identityRef?.current;

  let offset: number | undefined;
  const occurrence = doc.occurrence ?? 1;
  if (occurrence > 1) {
    let full: string | null;
    try {
      full = readDocFullText(contentDir, normalized.docName);
    } catch (err) {
      return textResult(
        `Error: cannot read "${normalized.docName}" to resolve occurrence ${occurrence}: ${err instanceof Error ? err.message : String(err)}.`,
        true,
      );
    }
    if (full === null) {
      return textResult(
        `Error: No document at "${normalized.docName}" on disk (paths are relative to the content root), so occurrence ${occurrence} cannot be resolved. If the path is wrong, fix it; edit only changes an existing document. If the document was just created and is not saved yet, retry with the first match (omit \`occurrence\`).`,
        true,
      );
    }
    const idx = nthOccurrenceOffset(full, doc.find as string, occurrence);
    if (idx === -1) {
      return textResult(
        `Error: \`find\` occurs fewer than ${occurrence} times in "${normalized.docName}".`,
        true,
      );
    }
    offset = idx;
  }

  const result = await httpPost(url, '/api/agent-patch', {
    docName: normalized.docName,
    find: doc.find,
    replace: doc.replace,
    ...(offset !== undefined ? { offset } : {}),
    ...(args.summary !== undefined ? { summary: args.summary } : {}),
    ...agentIdentityFields(identity),
  });
  const outcome = writeOutcomeOf(result);
  if (!result.ok && !landedWithoutSuccess(outcome)) {
    return failedWriteResult(errorTextWithDetail(result), outcome);
  }
  if (refusedDespiteSuccess(outcome)) {
    return refusedWriteResult(`The edit of "${normalized.docName}"`, outcome);
  }
  return composeWritePreviewResult(
    result,
    normalized.docName,
    cwd,
    contentDir,
    autoOpen,
    'Edit applied successfully.',
    outcome,
  );
}

async function handleDocFrontmatter(
  doc: { path: string; frontmatter: FrontmatterPatch },
  args: { summary?: string },
  cwd: string,
  contentDir: string,
  url: string,
  deps: EditDeps,
  autoOpen: boolean,
) {
  const normalized = normalizeDocName(doc.path);
  if (!normalized.ok) return textResult(okReservedPathRedirect(doc.path) ?? normalized.error, true);
  const identity = deps.identityRef?.current;
  const result = await httpPost(url, '/api/frontmatter-patch', {
    docName: normalized.docName,
    patch: doc.frontmatter,
    ...(args.summary !== undefined ? { summary: args.summary } : {}),
    ...agentIdentityFields(identity),
  });
  const outcome = writeOutcomeOf(result);
  if (!result.ok && !landedWithoutSuccess(outcome)) {
    const errorText = errorTextWithDetail(result);
    const fieldErrors =
      result.fieldErrors && typeof result.fieldErrors === 'object'
        ? (result.fieldErrors as Record<string, string>)
        : undefined;
    if (fieldErrors) {
      const lines = Object.entries(fieldErrors).map(([k, m]) => `  ${k}: ${m}`);
      return failedWriteResult(`${errorText}\n${lines.join('\n')}`, outcome);
    }
    return failedWriteResult(errorText, outcome);
  }
  if (refusedDespiteSuccess(outcome)) {
    return refusedWriteResult(`The frontmatter patch of "${normalized.docName}"`, outcome);
  }
  const setKeys: string[] = [];
  const deleteKeys: string[] = [];
  for (const [key, value] of Object.entries(doc.frontmatter)) {
    if (value === null) deleteKeys.push(key);
    else setKeys.push(key);
  }
  const opSummary = [
    setKeys.length ? `${setKeys.length} set` : '',
    deleteKeys.length ? `${deleteKeys.length} deleted` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return composeWritePreviewResult(
    result,
    normalized.docName,
    cwd,
    contentDir,
    autoOpen,
    `Frontmatter patched (${opSummary || `${Object.keys(doc.frontmatter).length} key(s)`}).`,
    outcome,
  );
}

function composeWritePreviewResult(
  result: Awaited<ReturnType<typeof httpPost>>,
  docName: string,
  cwd: string,
  _contentDir: string,
  autoOpen: boolean,
  leadLine: string,
  outcome: WriteOutcome | undefined,
) {
  const lockDir = resolveLockDir(cwd);
  const preview = resolvePreviewUrl(docName, { lockDir });
  const systemSubscriberCount =
    typeof result.systemSubscriberCount === 'number' ? result.systemSubscriberCount : undefined;
  const noPreviewAnywhere = systemSubscriberCount === 0;
  const summaryResult =
    result.summary && typeof result.summary === 'object'
      ? (result.summary as { value: string; truncatedFrom?: number; hint?: string })
      : undefined;
  const summaryHint = typeof summaryResult?.hint === 'string' ? summaryResult.hint : undefined;
  const advisoryWarnings = parseAdvisoryWarnings(result.warnings);
  const brokenLinks = parseBrokenLinks(result.brokenLinks);
  const brokenLinkSuppression = parseBrokenLinkSuppression(result.brokenLinkSuppression);

  const lines: string[] = [
    outcome && landedWithoutSuccess(outcome) ? landedLead(outcome, 'Edit applied') : leadLine,
  ];
  if (outcome?.outcome === 'projection-held' && typeof result.detail === 'string') {
    lines.push(result.detail);
  }
  if (noPreviewAnywhere && !preview) lines.push(startUiTextHint());
  if (summaryHint) lines.push(summaryHint);
  if (advisoryWarnings) {
    lines.push(...formatAdvisoryLines(advisoryWarnings));
  }
  lines.push(...formatBrokenLinkLines(brokenLinks));
  if (brokenLinkSuppression) lines.push(formatBrokenLinkSuppressionLine(brokenLinkSuppression));
  const outcomeLine = outcome?.outcome === 'applied' ? null : writeOutcomeLine(outcome);
  if (outcomeLine) lines.push(outcomeLine);
  const text = lines.join('\n');
  const document: Record<string, unknown> = {
    brokenLinks,
  };
  if (brokenLinkSuppression) document.brokenLinkSuppression = brokenLinkSuppression;
  if (summaryResult) document.summary = summaryResult;
  if (advisoryWarnings) document.warnings = advisoryWarnings;
  const warning = noPreviewAnywhere ? buildPreviewAttachWarning(preview, autoOpen) : undefined;
  return textPlusStructured(
    text,
    {
      ...nestDocResult(preview, warning, outcome?.outcome === 'projection-held' ? {} : document),
      ...writeOutcomeFields(outcome),
    },
    needsAttention(outcome),
  );
}

function templateFilePath(
  cwd: string,
  folder: string,
  name: string,
): { ok: true; abs: string } | { ok: false } {
  const contained = resolveWithinRoot(
    cwd,
    `${folder.replace(/\/+$/, '')}/.ok/templates/${name}.md`,
  );
  return contained.ok ? { ok: true, abs: contained.abs } : { ok: false };
}

function parseTemplateFrontmatter(raw: string): TemplateFrontmatter {
  const inner = unwrapFrontmatterFences(raw).trim();
  if (inner === '') return { title: '' };
  const parsed: unknown = parseYaml(inner);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { title: '' };
  const obj = parsed as Record<string, unknown>;
  return {
    title: typeof obj.title === 'string' ? obj.title : '',
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    ...(Array.isArray(obj.tags) ? { tags: obj.tags.map((t) => String(t)) } : {}),
  };
}

async function handleTemplate(
  template: {
    path: string;
    find?: string;
    replace?: string;
    occurrence?: number;
    frontmatter?: FrontmatterPatch;
  },
  summary: string | undefined,
  cwd: string,
  url: string | undefined,
  deps: EditDeps,
) {
  const teaching = bodyOrFrontmatterError(template, 'template');
  if (teaching) return textResult(`Error: ${teaching}`, true);

  const resolved = resolveTemplatePath(template.path);
  if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
  const { folder, name } = resolved;

  if (!url) return textResult(hocuspocusNotRunningError(), true);
  const filePath = templateFilePath(cwd, folder, name);
  if (!filePath.ok || !existsSync(filePath.abs)) {
    return textResult(
      `Error: template "${name}" not found in ${folder || '(root)'}. Create it with \`write({ template })\` first.`,
      true,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(filePath.abs, 'utf-8');
  } catch (err) {
    return textResult(`Error: could not read template: ${(err as Error).message}`, true);
  }
  const { frontmatter: fmRaw, body } = stripFrontmatter(raw);
  const existingFm = parseTemplateFrontmatter(fmRaw);

  if (template.frontmatter !== undefined) {
    const merged = mergePatch(
      existingFm as Record<string, unknown>,
      template.frontmatter as Record<string, unknown>,
    ) as TemplateFrontmatter;
    const result = await httpPut(url, '/api/template', {
      folder,
      name,
      body,
      frontmatter: merged,
      ...(summary !== undefined ? { summary } : {}),
      ...agentIdentityFields(deps.identityRef?.current),
    });
    const outcome = writeOutcomeOf(result);
    if (!result.ok)
      return failedWriteResult(
        errorTextWithDetail(result, TEMPLATE_METADATA_CONTROL_ADVICE),
        outcome,
      );
    if (refusedDespiteSuccess(outcome)) {
      return refusedWriteResult(`The frontmatter patch of template "${name}"`, outcome);
    }
    const path = typeof result.path === 'string' ? result.path : undefined;
    return templateEditResult(
      `Patched template "${name}" frontmatter${path ? ` (${path})` : ''}.`,
      path,
      outcome,
    );
  }

  const occurrence = template.occurrence ?? 1;
  const idx = nthOccurrenceOffset(body, template.find as string, occurrence);
  if (idx === -1) {
    return textResult(
      `Error: \`find\` occurs fewer than ${occurrence} time(s) in template "${name}".`,
      true,
    );
  }
  const newBody =
    body.slice(0, idx) +
    (template.replace as string) +
    body.slice(idx + (template.find as string).length);
  const result = await httpPut(url, '/api/template', {
    folder,
    name,
    body: newBody,
    frontmatter: existingFm,
    ...(summary !== undefined ? { summary } : {}),
    ...agentIdentityFields(deps.identityRef?.current),
  });
  const outcome = writeOutcomeOf(result);
  if (!result.ok)
    return failedWriteResult(errorTextWithDetail(result, TEMPLATE_EDIT_CONTROL_ADVICE), outcome);
  if (refusedDespiteSuccess(outcome)) {
    return refusedWriteResult(`The edit of template "${name}"`, outcome);
  }
  const path = typeof result.path === 'string' ? result.path : undefined;
  return templateEditResult(`Edited template "${name}"${path ? ` (${path})` : ''}.`, path, outcome);
}

function templateEditResult(
  lead: string,
  path: string | undefined,
  outcome: WriteOutcome | undefined,
) {
  const outcomeLine = outcome?.outcome === 'applied' ? null : writeOutcomeLine(outcome);
  return textPlusStructured(
    [leadFor(outcome, lead.replace(/\.$/, ''), lead), ...(outcomeLine ? [outcomeLine] : [])].join(
      '\n',
    ),
    { template: { ok: true, path }, ...writeOutcomeFields(outcome) },
    needsAttention(outcome),
  );
}

async function handleFolder(
  folder: { path: string; frontmatter: FrontmatterPatch },
  summary: string | undefined,
  url: string | undefined,
  deps: EditDeps,
) {
  if (!url) return textResult(hocuspocusNotRunningError(), true);
  const result = await httpPut(url, '/api/folder-config', {
    path: folder.path,
    frontmatter: folder.frontmatter,
    ...(summary !== undefined ? { summary } : {}),
    ...agentIdentityFields(deps.identityRef?.current),
  });
  if (!result.ok) return textResult(`Error: ${result.error}`, true);
  const applied = Array.isArray(result.applied) ? result.applied : [];
  const entry = (applied[0] ?? {}) as { path?: string; action?: string };
  const action = entry.action ?? 'written';
  const verb = action === 'deleted' ? 'Cleared' : action === 'noop' ? 'No change to' : 'Updated';
  return textPlusStructured(`${verb} folder properties for ${folder.path}.`, {
    folder: { ok: true, path: entry.path ?? `${folder.path}/.ok/frontmatter.yml`, action },
  });
}

export function register(server: ServerInstance, deps: EditDeps): void {
  const bodyFields = {
    find: z
      .string()
      .optional()
      .describe(
        'Exact BODY text to find. Use WITH `replace`. For metadata, use `frontmatter` instead — not this.',
      ),
    replace: z
      .string()
      .optional()
      .describe(
        'Replacement for the `find` match. Markdown C0 controls allow only TAB, LF and CR; remove others or use printable escapes.',
      ),
    occurrence: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Which match to edit (1 = first). Default: first.'),
  };

  server.registerTool(
    'edit',
    {
      description: DESCRIPTION,
      inputSchema: {
        document: z
          .object({
            path: z
              .string()
              .describe(
                'Document path, no extension — the slashes are its folder. Example: "meetings/standup".',
              ),
            ...bodyFields,
            frontmatter: FrontmatterArg.optional().describe(
              'Metadata merge-patch (set keys; `null` deletes a key). Use INSTEAD of find/replace.',
            ),
          })
          .optional()
          .describe(
            'Edit a DOCUMENT: its body (find+replace) OR its frontmatter (patch). Body: { document: { path, find, replace } }. Metadata: { document: { path, frontmatter } }.',
          ),
        folder: z
          .object({
            path: z.string().describe('Folder path.'),
            frontmatter: FrontmatterArg.describe(
              "Update the folder's own title/description/tags (merge-patch; `null` deletes).",
            ),
          })
          .optional()
          .describe(
            'Edit a FOLDER: only its frontmatter (folders have no body). Example: { folder: { path: "meetings", frontmatter: { description: "All-hands" } } }',
          ),
        template: z
          .object({
            path: z.string().describe(TEMPLATE_PATH_DESCRIBE),
            ...bodyFields,
            frontmatter: FrontmatterArg.optional().describe(
              'Template metadata merge-patch. Resubmits the full existing body; unsupported C0 controls anywhere in that body refuse the edit.',
            ),
          })
          .optional()
          .describe(
            'Edit a TEMPLATE: body (find+replace) or frontmatter (patch). Edits resubmit the full stored template body, including any supplied replace; unsupported C0 controls anywhere in that body refuse the edit. Remove controls from replace or clean the full body through write({ template: ... }).',
          ),
        summary: summaryArgSchema,
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        ...writeOutcomeOutputShape,
        document: z
          .object(documentResultBaseShape)
          .optional()
          .describe(
            'Document edit result. Present on every saved document edit, body or frontmatter (absent when the outcome is projection-held, whose links were not checked) — it carries `brokenLinks` (possibly `[]`) plus any `brokenLinkSuppression`/`summary`/`warnings`. Read `brokenLinkSuppression` and `warnings` before concluding anything from an empty `brokenLinks`: a suppression means a project policy withheld findings that are not yours to repair; a `link-check-deferred` warning means links were not checked yet. Absent only for folder/template edits.',
          ),
        folder: z
          .object({
            ok: z.boolean(),
            path: z.string(),
            action: z
              .string()
              .describe('`written` (created/updated) | `deleted` (cleared) | `noop`.'),
          })
          .optional()
          .describe('Folder frontmatter edit result.'),
        template: z
          .object({ ok: z.boolean(), path: z.string() })
          .optional()
          .describe('Template edit result.'),
        previewUrl: previewUrlOutputField.optional(),
        previewUrlSource: previewUrlSourceField,
        warning: previewAttachWarningField,
      }),
    },
    async (args: {
      document?: { path: string } & BodyEdit & { frontmatter?: FrontmatterPatch };
      folder?: { path: string; frontmatter: FrontmatterPatch };
      template?: { path: string } & BodyEdit & { frontmatter?: FrontmatterPatch };
      summary?: string;
      cwd?: string;
    }) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { cwd, config, url } = context;
      const contentDir = resolveContentDir(config, cwd);
      const autoOpen = config.appearance.preview.autoOpen;

      const teaching = exactlyOneTargetError(args as Record<string, unknown>, [
        'document',
        'folder',
        'template',
      ]);
      if (teaching) return textResult(`Error: ${teaching}`, true);

      if (args.document !== undefined) {
        const docTeaching = bodyOrFrontmatterError(args.document, 'document');
        if (docTeaching) return textResult(`Error: ${docTeaching}`, true);
        if (!url) return textResult(hocuspocusNotRunningError(), true);
        if (args.document.frontmatter !== undefined) {
          return handleDocFrontmatter(
            { path: args.document.path, frontmatter: args.document.frontmatter },
            args,
            cwd,
            contentDir,
            url,
            deps,
            autoOpen,
          );
        }
        return handleDocBody(args.document, args, cwd, contentDir, url, deps, autoOpen);
      }
      if (args.folder !== undefined) return handleFolder(args.folder, args.summary, url, deps);
      return handleTemplate(
        args.template as NonNullable<typeof args.template>,
        args.summary,
        cwd,
        url,
        deps,
      );
    },
  );
}
