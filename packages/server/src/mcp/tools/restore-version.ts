import { AdvisoryWarningSchema } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import type { AgentIdentity } from '../agent-identity.ts';
import { formatAdvisoryLines, parseAdvisoryWarnings } from './advisory-warnings.ts';
import { resolvePreviewUrlForTool } from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  agentIdentityFields,
  errorTextWithDetail,
  hocuspocusNotRunningError,
  httpGet,
  httpPost,
  normalizeDocName,
  outputSchemaWithText,
  previewUrlOutputField,
  previewUrlSourceField,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  summaryArgSchema,
  summaryOutputSchema,
  textPlusStructured,
  textResult,
  versionInputSchema,
} from './shared.ts';
import {
  failedWriteResult,
  leadFor,
  needsAttention,
  refusedDespiteSuccess,
  refusedWriteResult,
  writeOutcomeFields,
  writeOutcomeLine,
  writeOutcomeOf,
  writeOutcomeOutputShape,
} from './write-outcome.ts';

export const DESCRIPTION = [
  'Restore one document to version (40-char SHA from history). Requires the Hocuspocus server. document accepts optional .md/.mdx; restore is append-only through CRDT and visible to connected editors.',
  'Optional summary ≤80 chars; avoid secrets or PII, persisted to git history. content-divergence in structuredContent.warnings means restore landed but bytes differ: re-read with exec to see the converged result.',
].join('\n');

export interface RestoreVersionDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
}

export function register(server: ServerInstance, deps: RestoreVersionDeps): void {
  server.registerTool(
    'restore_version',
    {
      description: DESCRIPTION,
      inputSchema: {
        document: z.string().optional().describe('Document to restore (path, no extension).'),
        version: versionInputSchema.describe(
          "The 40-character commit SHA to restore to — copy it straight from a `history` entry's `version` field (same name there).",
        ),
        summary: summaryArgSchema.describe(
          'Optional one-line summary (≤80 chars). Defaults to "Restored to <sha-short>". Persisted to git history.',
        ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        ...writeOutcomeOutputShape,
        document: z
          .string()
          .optional()
          .describe('The document that was restored (echo of the input).'),
        version: z
          .string()
          .optional()
          .describe(
            'The version that was restored to (echo of the input); absent when the restore did not land.',
          ),
        previewUrl: previewUrlOutputField.optional(),
        previewUrlSource: previewUrlSourceField,
        summary: summaryOutputSchema.optional(),
        warnings: z
          .array(AdvisoryWarningSchema)
          .optional()
          .describe(
            'Advisory entries (kind `content-divergence`) present only when the restored Y.Text did not byte-match the target version.',
          ),
      }),
    },
    async (args: { document?: string; version: string; summary?: string; cwd?: string }) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { cwd, url } = context;
      if (!url) return textResult(hocuspocusNotRunningError(), true);

      if (args.document === undefined) {
        return textResult('Error: pass `document`.', true);
      }

      const normalized = normalizeDocName(args.document);
      if (!normalized.ok) return textResult(normalized.error, true);
      const docName = normalized.docName;

      const versionResult = await httpGet(
        url,
        `/api/history/${args.version}?docName=${encodeURIComponent(docName)}`,
      );
      if (!versionResult.ok) {
        return textResult(`Error: ${versionResult.error ?? 'Version not found'}`, true);
      }

      const identity = deps.identityRef?.current;
      const result = await httpPost(url, '/api/rollback', {
        docName,
        commitSha: args.version,
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...agentIdentityFields(identity),
      });
      const outcome = writeOutcomeOf(result);
      if (!result.ok) return failedWriteResult(errorTextWithDetail(result), outcome);
      if (refusedDespiteSuccess(outcome)) {
        return refusedWriteResult(`The restore of "${docName}"`, outcome);
      }

      const summaryResult =
        result.summary && typeof result.summary === 'object'
          ? (result.summary as { value: string; truncatedFrom?: number; hint?: string })
          : undefined;
      const summaryHint = typeof summaryResult?.hint === 'string' ? summaryResult.hint : undefined;

      const advisoryWarnings = parseAdvisoryWarnings(result.warnings);

      const author = typeof versionResult.author === 'string' ? versionResult.author : undefined;
      const timestamp =
        typeof versionResult.timestamp === 'string' ? versionResult.timestamp : undefined;
      const provenance = author && timestamp ? ` (${author}, ${timestamp})` : '';
      const textLines = [
        leadFor(
          outcome,
          `Restored "${docName}" to version ${args.version.slice(0, 8)}`,
          `Restored "${docName}" to version ${args.version.slice(0, 8)}${provenance}. The change has been applied to all connected editors.`,
        ),
      ];
      if (summaryHint) textLines.push(summaryHint);
      if (advisoryWarnings) {
        textLines.push(...formatAdvisoryLines(advisoryWarnings));
      }
      const outcomeLine = outcome?.outcome === 'applied' ? null : writeOutcomeLine(outcome);
      if (outcomeLine) textLines.push(outcomeLine);

      const preview = await resolvePreviewUrlForTool(
        docName,
        { config: deps.config, resolveCwd: deps.resolveCwd },
        cwd,
      );
      return textPlusStructured(
        textLines.join('\n'),
        {
          document: docName,
          version: args.version,
          previewUrl: preview?.url ?? null,
          ...(preview ? { previewUrlSource: preview.source } : {}),
          ...(summaryResult ? { summary: summaryResult } : {}),
          ...(advisoryWarnings ? { warnings: advisoryWarnings } : {}),
          ...writeOutcomeFields(outcome),
        },
        needsAttention(outcome),
      );
    },
  );
}
