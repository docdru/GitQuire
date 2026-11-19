import type { ServerInstance } from '../mcp/tools/shared.ts';
import { DRAFT_SLUG_ENV, DRAFT_TITLE_ENV } from './workspace.ts';

type Env = Readonly<Record<string, string | undefined>>;
type AnyHandler = (...args: unknown[]) => unknown;

export const EDITING_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'delete',
  'move',
  'restore_version',
]);

let liveHasDrafts = false;

export function markDraftsAvailable(): void {
  liveHasDrafts = true;
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function editDestinationNote(env: Env, draftsAvailable = liveHasDrafts): string | undefined {
  const slug = text(env[DRAFT_SLUG_ENV]);
  if (slug !== undefined) {
    const title = text(env[DRAFT_TITLE_ENV]) ?? slug;
    return `This change is in the draft "${title}", not in the live wiki. It goes live when someone publishes the draft.`;
  }
  return draftsAvailable ? 'This change is in the live wiki, which everyone sees.' : undefined;
}

export function withEditDestination(result: unknown, note: string | undefined): unknown {
  if (note === undefined || typeof result !== 'object' || result === null) return result;
  const record = result as {
    isError?: unknown;
    content?: unknown;
    structuredContent?: unknown;
  };
  if (record.isError === true || !Array.isArray(record.content)) return result;
  const index = record.content.findIndex(
    (part: { type?: unknown; text?: unknown }) =>
      part?.type === 'text' && typeof part.text === 'string',
  );
  if (index === -1) return result;
  const content = record.content.map((part: { text: string }, at: number) =>
    at === index ? { ...part, text: `${part.text}\n\n${note}` } : part,
  );
  const structured = record.structuredContent as { text?: unknown } | undefined;
  return {
    ...record,
    content,
    ...(structured !== undefined && typeof structured.text === 'string'
      ? { structuredContent: { ...structured, text: `${structured.text}\n\n${note}` } }
      : {}),
  };
}

export function reportEditDestination(
  server: ServerInstance,
  env: Env = process.env,
): ServerInstance {
  const raw = (server as unknown as { registerTool?: AnyHandler }).registerTool;
  if (typeof raw !== 'function') return server;
  const register = raw.bind(server);
  const wrapped = Object.create(server) as ServerInstance;
  (wrapped as unknown as { registerTool: AnyHandler }).registerTool = (
    name: unknown,
    config: unknown,
    handler: unknown,
  ) => {
    if (typeof handler !== 'function' || !EDITING_TOOLS.has(String(name))) {
      return register(name, config, handler);
    }
    const original = handler as AnyHandler;
    return register(name, config, async (...args: unknown[]) =>
      withEditDestination(await original(...args), editDestinationNote(env)),
    );
  };
  return wrapped;
}
