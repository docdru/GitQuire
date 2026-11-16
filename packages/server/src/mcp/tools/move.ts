import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';
import type { AgentIdentity } from '../agent-identity.ts';
import { resolveWithinRoot } from './path-safety.ts';
import { type PreviewUrlSource, resolvePreviewUrlForTool } from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  agentIdentityFields,
  hocuspocusNotRunningError,
  httpPost,
  looseObjectArray,
  normalizeDocName,
  outputSchemaWithText,
  parseRenameCollidingPairs,
  previewUrlSourceField,
  previousPreviewUrlField,
  type RenameCollisionPair,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  summaryArgSchema,
  summaryOutputSchema,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { resolveTemplatePath } from './verb-schemas.ts';

const DESCRIPTION = [
  'For .md/.mdx inspection before or after a move in a project with .gitquire/, use exec; native Read/Grep/Glob omit wiki context.',
  'Move/rename a document, folder or asset with `{from, to}`, or a template with `{template: {from, to}}`. Choose one form. Requires the Hocuspocus server. Document/folder/asset kind is auto-detected.',
  "Paths: docs accept optional .md/.mdx; folders are relative with no leading/trailing slash; assets include the extension. Templates use '<folder>/<name>'; inherited templates cannot move (move their local copy or owning folder). Template moves rewrite no inbound links.",
  'Links to the moved document keep pointing to it. The old path stops existing; do not leave a redirect or stub.',
  'Managed moves preserve wiki-link targets and rewrite supported inline Markdown links; renamed assets are reported.',
  'Optional summary: one-line outcome ≤80 chars. If omitted, defaults to "Renamed X → Y". Avoid secrets or PII; persisted to git history. Invalid/excluded paths, missing sources and existing destinations are refused; collisions report colliding[].',
].join('\n');

interface RenameMapping {
  fromDocName: string;
  toDocName: string;
}
interface RenameRewrittenDoc {
  docName: string;
  rewrites: number;
}
interface RenamedAsset {
  fromPath: string;
  toPath: string;
}

export interface MoveDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
}

interface MoveArgs {
  from?: string;
  to?: string;
  template?: { from: string; to: string };
  summary?: string;
  cwd?: string;
}

function parseRenameMappings(value: unknown): RenameMapping[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { fromDocName, toDocName } = entry as Record<string, unknown>;
    return typeof fromDocName === 'string' && typeof toDocName === 'string'
      ? [{ fromDocName, toDocName }]
      : [];
  });
}

function parseRewrittenDocs(value: unknown): RenameRewrittenDoc[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { docName, rewrites } = entry as Record<string, unknown>;
    return typeof docName === 'string' && typeof rewrites === 'number'
      ? [{ docName, rewrites }]
      : [];
  });
}

function parseRenamedAssets(value: unknown): RenamedAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { fromPath, toPath } = entry as Record<string, unknown>;
    return typeof fromPath === 'string' && typeof toPath === 'string' ? [{ fromPath, toPath }] : [];
  });
}

function isValidFolderPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || path.endsWith('/')) return false;
  if (path.includes('..')) return false;
  return true;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function resolveMoveKind(contentDir: string, from: string): 'file' | 'folder' | 'asset' | null {
  const contained = resolveWithinRoot(contentDir, from);
  if (!contained.ok) return null;
  const absBase = contained.abs;
  if (existsSync(absBase)) {
    try {
      const stat = statSync(absBase);
      if (stat.isDirectory()) return 'folder';
      if (stat.isFile()) {
        return absBase.endsWith('.md') || absBase.endsWith('.mdx') ? 'file' : 'asset';
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return 'file';
    }
  }
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    if (existsSync(`${absBase}${ext}`)) return 'file';
  }
  return null;
}

export function register(server: ServerInstance, deps: MoveDeps): void {
  server.registerTool(
    'move',
    {
      description: DESCRIPTION,
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe('Current path of a document, folder, or asset (auto-detected).'),
        to: z
          .string()
          .optional()
          .describe(
            'New path. Links keep their intended targets; supported inline links are rewritten.',
          ),
        template: z
          .object({ from: z.string(), to: z.string() })
          .optional()
          .describe(
            'Move/rename a TEMPLATE instead: `{ from: "<folder>/<name>", to: "<folder>/<name>" }`. Nested because a flat path cannot disambiguate a template under `.gitquire/templates/` from a same-named doc. Mutually exclusive with flat `from`/`to`.',
          ),
        summary: summaryArgSchema.describe(
          'Optional one-line user-outcome (≤80 chars). Defaults to "Renamed X → Y". Persisted to git history.',
        ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        ok: z.boolean().describe('Whether the move succeeded.'),
        kind: z
          .enum(['file', 'folder', 'asset', 'template'])
          .optional()
          .describe(
            'What was moved (`file`/`folder`/`asset` auto-detected from `from`; `template` when that nested target was used).',
          ),
        committed: z
          .boolean()
          .optional()
          .describe(
            'Template move: `true` = tracked `git mv` (history preserved), `false` = plain disk rename.',
          ),
        renamed: z
          .array(
            z.object({
              fromDocName: z.string(),
              toDocName: z.string(),
            }),
          )
          .optional()
          .describe('docName remappings performed.'),
        rewrittenDocs: looseObjectArray
          .optional()
          .describe('Docs whose inbound links were rewritten.'),
        renamedAssets: looseObjectArray
          .optional()
          .describe('Referenced assets that were moved alongside.'),
        previewUrls: z
          .record(z.string(), z.string())
          .optional()
          .describe('Route-only preview URL per new docName.'),
        previewUrlSource: previewUrlSourceField,
        previousPreviewUrl: previousPreviewUrlField,
        summary: summaryOutputSchema.optional(),
        error: z.string().optional().describe('Present when `ok` is false.'),
        colliding: looseObjectArray
          .optional()
          .describe('On a 409 collision: the conflicting from→to pairs.'),
      }),
    },
    async (args: MoveArgs) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { cwd, config, url } = context;
      if (!url) return textResult(hocuspocusNotRunningError(), true);

      if (args.template !== undefined) {
        if (args.from !== undefined || args.to !== undefined) {
          return textResult(
            'Error: pass EITHER flat `from`/`to` (document/folder/asset) OR `template: { from, to }` — not both.',
            true,
          );
        }
        const rf = resolveTemplatePath(args.template.from);
        if (!rf.ok) return textResult(`Error: ${rf.error}`, true);
        const rt = resolveTemplatePath(args.template.to);
        if (!rt.ok) return textResult(`Error: ${rt.error}`, true);
        const result = await httpPost(url, '/api/template', {
          fromFolder: rf.folder,
          fromName: rf.name,
          toFolder: rt.folder,
          toName: rt.name,
          ...(args.summary !== undefined ? { summary: args.summary } : {}),
          ...agentIdentityFields(deps.identityRef?.current),
        });
        if (!result.ok) {
          const error = typeof result.error === 'string' ? result.error : 'Template move failed';
          return textPlusStructured(
            `Error: ${error}`,
            { ok: false, kind: 'template', error },
            true,
          );
        }
        const committed = result.committed === true;
        const fromLabel = typeof result.from === 'string' ? result.from : args.template.from;
        const toLabel = typeof result.to === 'string' ? result.to : args.template.to;
        return textPlusStructured(
          `${committed ? 'Renamed' : 'Moved'} template ${fromLabel} → ${toLabel}.${committed ? '' : ' (Untracked `.gitquire/` — moved on disk without git history.)'}`,
          { ok: true, kind: 'template', committed },
        );
      }

      if (args.from === undefined || args.to === undefined) {
        return textResult(
          'Error: provide both `from` and `to` (or use `template: { from, to }` to move a template).',
          true,
        );
      }

      const contentDir = join(cwd, config.content.dir);
      const kind = resolveMoveKind(contentDir, args.from);
      if (kind === null) {
        const split = resolveTemplatePath(args.from);
        if (
          split.ok &&
          existsSync(join(contentDir, split.folder, '.gitquire', 'templates', `${split.name}.md`))
        ) {
          return textResult(
            `Error: \`${args.from}\` is a template, not a doc/folder/asset. Move it with \`move({ template: { from: "${args.from}", to: "<folder>/<newName>" } })\`.`,
            true,
          );
        }
        return textResult(
          `Error: \`${args.from}\` does not exist as a doc, folder, or asset under the content directory.`,
          true,
        );
      }

      let fromPath = args.from;
      let toPath = args.to;
      if (kind === 'file') {
        const nf = normalizeDocName(args.from);
        if (!nf.ok) return textResult(nf.error, true);
        const nt = normalizeDocName(args.to);
        if (!nt.ok) return textResult(nt.error, true);
        fromPath = nf.docName;
        toPath = nt.docName;
      } else if (kind === 'folder') {
        if (!isValidFolderPath(args.from) || !isValidFolderPath(args.to)) {
          return textResult(
            'Error: folder `from`/`to` must be relative paths with no leading/trailing slash.',
            true,
          );
        }
      }

      const result = await httpPost(url, '/api/rename-path', {
        kind,
        fromPath,
        toPath,
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...agentIdentityFields(deps.identityRef?.current),
      });
      if (!result.ok) {
        const error = result.error as string;
        const colliding = parseRenameCollidingPairs(result.colliding);
        const structured: { ok: false; error: string; colliding?: RenameCollisionPair[] } = {
          ok: false,
          error,
          ...(colliding.length > 0 ? { colliding } : {}),
        };
        return textPlusStructured(`Error: ${error}`, structured, true);
      }

      const renamed = parseRenameMappings(result.renamed);
      const rewrittenDocs = parseRewrittenDocs(result.rewrittenDocs);
      const renamedAssets = parseRenamedAssets(result.renamedAssets);

      const previewDeps = { config: deps.config, resolveCwd: deps.resolveCwd };
      const previewUrls: Record<string, string> = {};
      let previewUrlSource: PreviewUrlSource | undefined;
      let previousPreviewUrl: string | undefined;
      if (kind === 'file') {
        const newPreview = await resolvePreviewUrlForTool(toPath, previewDeps, cwd);
        const oldPreview = await resolvePreviewUrlForTool(fromPath, previewDeps, cwd);
        if (newPreview) {
          previewUrls[toPath] = newPreview.url;
          previewUrlSource = newPreview.source;
        }
        if (oldPreview) previousPreviewUrl = oldPreview.url;
      } else if (kind === 'folder') {
        for (const { toDocName } of renamed) {
          const preview = await resolvePreviewUrlForTool(toDocName, previewDeps, cwd);
          if (preview) {
            previewUrls[toDocName] = preview.url;
            previewUrlSource ??= preview.source;
          }
        }
      }

      const summaryResult =
        result.summary && typeof result.summary === 'object'
          ? (result.summary as { value: string; truncatedFrom?: number; hint?: string })
          : undefined;
      const summaryHint = typeof summaryResult?.hint === 'string' ? summaryResult.hint : undefined;

      const textLines: string[] = [];
      if (kind === 'asset') {
        textLines.push(`Moved asset ${fromPath} → ${toPath}.`);
      } else if (kind === 'folder') {
        textLines.push(
          renamed.length === 0
            ? `No managed docs under ${args.from}/ — nothing to rename. Empty folders are not tracked.`
            : `Renamed folder ${args.from}/ → ${args.to}/ (${renamed.length} doc${renamed.length === 1 ? '' : 's'}, ${rewrittenDocs.length} rewrite${rewrittenDocs.length === 1 ? '' : 's'}).`,
        );
      } else {
        const renamedSummary =
          renamed
            .map(({ fromDocName, toDocName }) => `${fromDocName} -> ${toDocName}`)
            .join(', ') || `${fromPath} -> ${toPath}`;
        const rewrittenSummary =
          rewrittenDocs.length === 0
            ? 'No inbound links required updates.'
            : `Rewrote ${rewrittenDocs.length} ${pluralize(rewrittenDocs.length, 'document')}.`;
        textLines.push(`Renamed ${renamedSummary}. ${rewrittenSummary}`);
      }
      if (renamedAssets.length > 0) {
        textLines.push(
          `Moved ${renamedAssets.length} referenced ${pluralize(renamedAssets.length, 'asset')}.`,
        );
      }
      if (summaryHint) textLines.push(summaryHint);

      return textPlusStructured(textLines.join('\n'), {
        ok: true,
        kind,
        renamed,
        rewrittenDocs,
        ...(renamedAssets.length > 0 ? { renamedAssets } : {}),
        ...(Object.keys(previewUrls).length > 0 ? { previewUrls } : {}),
        ...(previewUrlSource ? { previewUrlSource } : {}),
        ...(previousPreviewUrl ? { previousPreviewUrl } : {}),
        ...(summaryResult ? { summary: summaryResult } : {}),
      });
    },
  );
}
