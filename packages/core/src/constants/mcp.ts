import { DESKTOP_PRODUCTS } from './product.ts';

export const MCP_SERVER_NAME = DESKTOP_PRODUCTS.stable.mcpServerName;

export const SERVER_UNREACHABLE_ERROR_PREFIX = 'Server unreachable:';

export const SERVER_TIMEOUT_ERROR_PREFIX = 'Server timed out:';

export const OPEN_KNOWLEDGE_MCP_TOOLS = [
  'exec',
  'search',
  'history',
  'links',
  'config',
  'palette',
  'workspace',
  'preview_url',
  'share_link',
  'lint',
  'audit',
  'write',
  'edit',
  'delete',
  'move',
  'checkpoint',
  'restore_version',
] as const;

export const GQ_HOSTED_AGENT_ENV = 'GITQUIRE_HOSTED_AGENT';

export const GQ_DESKTOP_TERMINAL_ENV = 'GITQUIRE_DESKTOP_TERMINAL';

export function resolveIsHostedAgent(env: Record<string, string | undefined>): boolean {
  return env[GQ_DESKTOP_TERMINAL_ENV] === '1' || env[GQ_HOSTED_AGENT_ENV] === '1';
}
