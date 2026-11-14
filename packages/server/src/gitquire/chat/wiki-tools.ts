import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { encodeProxiedUser, PROXIED_PRINCIPAL_HEADER, type SessionUser } from '../access-gate.ts';
import { internalRequestHeaders } from '../internal-request.ts';
import type { ToolSpec } from './providers.ts';

export const WIKI_TOOL_NAMES = [
  'search',
  'exec',
  'links',
  'history',
  'lint',
  'write',
  'edit',
  'move',
] as const;

const WRITE_TARGETS = new Set(['document', 'documents', 'folder', 'summary', 'cwd']);
const EDIT_TARGETS = new Set(['document', 'folder', 'summary', 'cwd']);
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

export interface WikiToolResult {
  output: string;
  isError: boolean;
}

export interface WikiTools {
  specs: readonly ToolSpec[];
  call(name: string, input: Record<string, unknown>): Promise<WikiToolResult>;
  close(): Promise<void>;
}

export type OpenWikiTools = (
  user: SessionUser,
  port: number,
  signal?: AbortSignal,
) => Promise<WikiTools>;

export function refusedArguments(name: string, input: Record<string, unknown>): string | undefined {
  const allowed = name === 'write' ? WRITE_TARGETS : name === 'edit' ? EDIT_TARGETS : undefined;
  if (allowed === undefined) return undefined;
  const refused = Object.keys(input).filter((key) => !allowed.has(key));
  if (refused.length === 0) return undefined;
  return `In this chat, ${name} only changes pages and folders (not ${refused.join(', ')}).`;
}

export function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…(output shortened: ${text.length - MAX_TOOL_OUTPUT_CHARS} more characters)`;
}

function resultText(result: unknown): string {
  const record = (result ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content as Record<string, unknown>[]) {
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  if (parts.length === 0 && record.structuredContent !== undefined) {
    parts.push(JSON.stringify(record.structuredContent));
  }
  return parts.join('\n');
}

function restrictedSchema(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  const allowed = name === 'write' ? WRITE_TARGETS : name === 'edit' ? EDIT_TARGETS : undefined;
  if (allowed === undefined) return schema;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(properties).filter(([key]) => allowed.has(key))),
  };
}

export function createLoopbackWikiTools(options: {
  clientName: string;
  version: string;
}): OpenWikiTools {
  return async (user, port, signal) => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          ...internalRequestHeaders(),
          [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser(user),
        },
      },
    });
    const client = new Client({ name: options.clientName, version: options.version });
    await client.connect(transport);
    try {
      const listed = await client.listTools(undefined, { signal });
      const allowed = new Set<string>(WIKI_TOOL_NAMES);
      const specs: ToolSpec[] = listed.tools
        .filter((tool) => allowed.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: restrictedSchema(tool.name, tool.inputSchema as Record<string, unknown>),
        }));
      return {
        specs,
        async call(name, input) {
          if (!allowed.has(name) || !specs.some((spec) => spec.name === name)) {
            return { output: `There is no tool called ${name}.`, isError: true };
          }
          const refused = refusedArguments(name, input);
          if (refused !== undefined) return { output: refused, isError: true };
          try {
            const result = await client.callTool({ name, arguments: input }, undefined, { signal });
            return {
              output: truncateOutput(resultText(result)),
              isError: (result as { isError?: unknown }).isError === true,
            };
          } catch (err) {
            if (signal?.aborted) throw err;
            return {
              output: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        },
        close: () => client.close(),
      };
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  };
}
