import { z } from 'zod';
import { describeWorkspace, resolveWorkspace } from '../../gitquire/workspace.ts';
import type { ServerInstance } from './shared.ts';
import { outputSchemaWithText, ROUTED_CWD_DESCRIPTION, textPlusStructured } from './shared.ts';

const DESCRIPTION = [
  'Say where this session reads and writes: the live wiki, or a draft (a proposal on its own branch that is published later), with the branch name. Pure read.',
  'Call it before the first change when the person names a draft, a branch or a pull request, and whenever they ask where you are working. If the answer differs from what they asked for, stop and tell them instead of editing.',
].join('\n');

interface WorkspaceDeps {
  resolveCwd: (explicit?: string) => Promise<string>;
}

const InputSchema = {
  cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
} as const;

const OutputSchema = outputSchemaWithText({
  kind: z
    .enum(['live', 'draft'])
    .describe('`live` is the wiki everyone sees; `draft` is a proposal.'),
  branch: z.string().nullable().describe('Checked-out Git branch; null when HEAD is detached.'),
  draft: z
    .object({
      slug: z.string(),
      title: z.string(),
      base: z.string().nullable().describe('Branch the draft started from.'),
    })
    .nullable()
    .describe('The draft this session works in; null in the live wiki.'),
});

export function register(server: ServerInstance, deps: WorkspaceDeps): void {
  server.registerTool(
    'workspace',
    {
      description: DESCRIPTION,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args: { cwd?: string }) => {
      let cwd: string;
      try {
        cwd = await deps.resolveCwd(args.cwd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
      }
      const workspace = resolveWorkspace(process.env, cwd);
      return textPlusStructured(describeWorkspace(workspace), { ...workspace });
    },
  );
}
