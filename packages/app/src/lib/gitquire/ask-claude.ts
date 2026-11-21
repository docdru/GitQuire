import { agentsPaneIsChat, type GitQuireFeatures, hasClaudeAccess } from './features';

export type ClaudeDestination = 'claude-web' | 'claude-app' | 'claude-code';
export type AskDestination = ClaudeDestination | 'gitquire-chat';

const CLAUDE_DESTINATIONS: readonly ClaudeDestination[] = [
  'claude-web',
  'claude-app',
  'claude-code',
];

export function askDestinations(features: GitQuireFeatures): AskDestination[] {
  return [
    ...(agentsPaneIsChat(features) ? (['gitquire-chat'] as const) : []),
    ...(hasClaudeAccess(features) ? CLAUDE_DESTINATIONS : []),
  ];
}

export function isAskDestination(value: unknown): value is AskDestination {
  return value === 'gitquire-chat' || isClaudeDestination(value);
}

export function defaultAskDestination(
  features: GitQuireFeatures,
  stored: string | null,
): AskDestination {
  const available = askDestinations(features);
  if (isAskDestination(stored) && available.includes(stored)) return stored;
  if (available.includes('gitquire-chat')) return 'gitquire-chat';
  return defaultDestination(features, null);
}

export const MAX_REQUEST_CHARS = 4000;
const DESTINATION_STORAGE_KEY = 'gitquire.askClaude.destination';

export type AskWorkspace = { kind: 'live' } | { kind: 'draft'; title: string; branch: string };

export function askWorkspace(drafts: {
  list: { enabled: boolean } | null;
  current: { viewing: { title: string; branch: string } | null } | null;
}): AskWorkspace | undefined {
  if (drafts.list?.enabled !== true || drafts.current === null) return undefined;
  const viewing = drafts.current.viewing;
  return viewing === null
    ? { kind: 'live' }
    : { kind: 'draft', title: viewing.title, branch: viewing.branch };
}

function workspaceLine(workspace: AskWorkspace): string {
  if (workspace.kind === 'live') return 'Workspace: the live wiki';
  return `Workspace: the draft "${workspace.title}" (branch ${workspace.branch}), not the live wiki. Check with the workspace tool before changing anything; if it reports a different place, stop and tell me.`;
}

export interface ClaudePromptInput {
  wikiUrl: string;
  wiki?: string;
  workspace?: AskWorkspace;
  target: { kind: 'page' | 'folder'; path: string };
  request: string;
}

export function buildClaudePrompt(input: ClaudePromptInput): string {
  const where =
    input.target.kind === 'page'
      ? `Page: ${input.target.path}`
      : `Folder: ${input.target.path === '' ? '(the whole wiki)' : input.target.path}`;
  const request = input.request.trim().slice(0, MAX_REQUEST_CHARS);
  return [
    input.wiki === undefined
      ? `Use the GitQuire wiki tools (the MCP server for ${input.wikiUrl}) for this.`
      : `Use the GitQuire wiki tools (the MCP server for ${input.wikiUrl}) for this, in the wiki ${input.wiki}: give "${input.wiki}" as the wiki argument of every call.`,
    '',
    ...(input.workspace === undefined ? [] : [workspaceLine(input.workspace)]),
    where,
    '',
    request,
  ].join('\n');
}

export function claudeLink(destination: ClaudeDestination, prompt: string): string {
  const q = encodeURIComponent(prompt);
  switch (destination) {
    case 'claude-web':
      return `https://claude.ai/new?q=${q}`;
    case 'claude-app':
      return `claude://claude.ai/new?q=${q}`;
    case 'claude-code':
      return `claude://code/new?q=${q}`;
    default: {
      const unreachable: never = destination;
      throw new Error(`Unknown destination ${String(unreachable)}`);
    }
  }
}

export function isClaudeDestination(value: unknown): value is ClaudeDestination {
  return typeof value === 'string' && (CLAUDE_DESTINATIONS as readonly string[]).includes(value);
}

export function defaultDestination(
  features: Pick<GitQuireFeatures, 'agentToken' | 'connector'>,
  stored: string | null,
): ClaudeDestination {
  if (isClaudeDestination(stored)) return stored;
  return features.connector ? 'claude-web' : 'claude-code';
}

export function loadStoredDestination(): string | null {
  try {
    return window.localStorage.getItem(DESTINATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeDestination(destination: AskDestination): void {
  try {
    window.localStorage.setItem(DESTINATION_STORAGE_KEY, destination);
  } catch {}
}

export function openClaudeLink(url: string): void {
  if (url.startsWith('https://')) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  window.location.assign(url);
}

export function askClaudeAddress(
  origin: string,
  prefix: string,
): { wikiUrl: string; wiki?: string } {
  if (!prefix.startsWith('/w/')) return { wikiUrl: `${origin}${prefix}` };
  return { wikiUrl: origin, wiki: prefix.slice('/w/'.length) };
}
