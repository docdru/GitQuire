import {
  type FrontmatterValue,
  FrontmatterValueSchema,
  frontmatterRecord,
  TEMPLATE_NAME_REGEX,
  TEMPLATE_NAME_RULE,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';

const FrontmatterPatchValue = z.union([FrontmatterValueSchema, z.null()]);

const FrontmatterAdvertisedValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
  z.null(),
]) as unknown as z.ZodType<FrontmatterValue | null>;

export const FrontmatterArg = frontmatterRecord(FrontmatterAdvertisedValue)
  .superRefine((patch, ctx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (!FrontmatterPatchValue.safeParse(value).success) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            'invalid frontmatter value — allowed: a scalar (string | number | boolean), a scalar array, ' +
            'a nested object, or an array of objects; a top-level key may be null to delete it, but nested null is not allowed',
        });
      }
    }
  })
  .describe(
    'Metadata as a key→value map. Values may be a scalar (string | number | boolean), a scalar array, ' +
      'a nested object, or an array of objects. Merge-patch: include a top-level key to set it, set a ' +
      'top-level key to null to delete it; keys you omit are unchanged. A nested object REPLACES the ' +
      'existing subtree at that key (send the full subtree you want). ' +
      'Example: { title: "Q3 Planning", tags: ["planning"], metadata: { version: "1.0", author: "Inkeep" } }.',
  );

const POSITIONS = ['append', 'prepend', 'replace'] as const;
export const PositionArg = z
  .enum(POSITIONS)
  .describe(
    'Where content lands. replace = overwrite the whole body (default for a new doc; required for an existing doc). ' +
      'append / prepend = add to the end / start.',
  );

export const DocExtensionArg = z
  .enum(SUPPORTED_DOC_EXTENSIONS)
  .describe(
    'File format for a NEW doc: `.md` (default) or `.mdx` (Markdown + JSX components). ' +
      'Honored only on create — an existing doc keeps its on-disk extension. ' +
      'Takes precedence over an extension typed into `path`.',
  );

export function splitTargetPath(path: string): { folder: string; name: string } {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx === -1
    ? { folder: '', name: clean }
    : { folder: clean.slice(0, idx), name: clean.slice(idx + 1) };
}

export const TEMPLATE_PATH_DESCRIBE = `Template path = \`<folder>/<name>\` (e.g. "fishing-log/trip-log"). The slashes are the folder it belongs to; the final segment is the template name, which must use ${TEMPLATE_NAME_RULE}. Stored at \`<folder>/.ok/templates/<name>.md\`.`;
export const TEMPLATE_CONTENT_DESCRIBE =
  "Starter content — the Markdown a new document becomes. A leading `---…---` frontmatter block here sets the STARTING PROPERTIES every doc created from this template gets (e.g. `type`, `status`, `tags`); the markdown below it is the body. The template's own picker identity (title/description) is the separate `frontmatter` field, NOT this block — it is stripped at instantiation and never copied onto created docs. (On disk this composes to one frontmatter block with the identity under a reserved `template:` key; you don't author that — just give the starter content here.) Only the `{{date}}` and `{{user}}` substitution tokens are allowed; any other `{{...}}` token hard-errors at write time.";

export function resolveTemplatePath(
  path: string,
): { ok: true; folder: string; name: string } | { ok: false; error: string } {
  const { folder, name } = splitTargetPath(path);
  if (!TEMPLATE_NAME_REGEX.test(name)) {
    return {
      ok: false,
      error: `the final segment of a template path is its name — "${name}" must use ${TEMPLATE_NAME_RULE}. e.g. { template: { path: "fishing-log/trip-log" } }.`,
    };
  }
  return { ok: true, folder, name };
}

export const TEMPLATE_EDIT_CONTROL_ADVICE =
  'Any body offset refers to the full stored template body resubmitted by this edit, including any supplied replace. Clean controls in replace, or, if stored controls remain, use a clean full replacement through write({ template: ... }).';
export const TEMPLATE_METADATA_CONTROL_ADVICE =
  'Any body offset refers to the full stored template body resubmitted by this edit. Remove stored controls through a clean full replacement using write({ template: ... }).';
export function exactlyOneTargetError(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  const present = keys.filter((k) => args[k] !== undefined);
  if (present.length === 1) return null;
  const quoted = keys.map((k) => `\`${k}\``).join(', ');
  if (present.length === 0) {
    return (
      `Name exactly one of ${quoted} — the one thing you are addressing. ` +
      "Nest that target's fields under its key (e.g. `{ document: { path, … } }`); " +
      "see this tool's parameter docs for which fields each target takes."
    );
  }
  return `You named ${present.map((k) => `\`${k}\``).join(' and ')} — name exactly ONE target.`;
}
